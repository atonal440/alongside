package com.atonal440.alongside.data

import com.atonal440.alongside.data.sync.SyncApi
import com.atonal440.alongside.data.sync.SyncCursor
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.util.concurrent.TimeUnit

/**
 * A reply the server refused. [code] is the v2 contract error code (`structural_conflict`, …),
 * [currentRevision] the revision the server holds now when it sent one with a `revision_conflict`,
 * and [syncReset] is true when the cursor was rejected and the client must start from a snapshot.
 */
class ApiException(
    val status: Int,
    message: String,
    val code: String? = null,
    val currentRevision: Long? = null,
    val syncReset: Boolean = false,
) : IOException(message)

/**
 * Client for the worker's v2 endpoints, the same ones the PWA's sync engine uses: workspace
 * snapshot and delta for reads, entity reads for command guards, and `/api/v2/changes` for
 * writes. It announces itself with `X-Alongside-Client` (the PWA's version gate ignores other
 * client names, and the Android client sends no `Origin`).
 */
class AlongsideApi(baseUrl: String, private val token: String) : SyncApi {
    private val base = baseUrl.trimEnd('/')

    override suspend fun snapshot(): JsonObject = parse(call("GET", "/api/v2/sync/snapshot", null))

    override suspend fun delta(cursor: SyncCursor, watermark: SyncCursor?, limit: Int): JsonObject =
        parse(call("POST", "/api/v2/sync/delta", buildJsonObject {
            put("cursor", buildJsonObject { put("epoch", cursor.epoch); put("sequence", cursor.sequence) })
            if (watermark != null) put("watermark", buildJsonObject { put("epoch", watermark.epoch); put("sequence", watermark.sequence) })
            put("limit", limit)
        }))

    override suspend fun entity(entity: String, id: String): JsonObject =
        parse(call("POST", "/api/v2/entity", buildJsonObject { put("entity", entity); put("id", id) }))

    /** Apply a v2 command envelope. Same command id + payload replays; a 2xx means it is settled. */
    override suspend fun applyChanges(envelope: JsonObject) {
        call("POST", "/api/v2/changes", envelope)
    }

    private fun parse(text: String): JsonObject = try {
        json.parseToJsonElement(text).jsonObject
    } catch (e: SerializationException) {
        throw ApiException(0, UNREADABLE)
    } catch (e: IllegalArgumentException) {
        throw ApiException(0, UNREADABLE)
    }

    private suspend fun call(method: String, path: String, body: JsonObject?): String = withContext(Dispatchers.IO) {
        val url = (base + path).toHttpUrlOrNull() ?: throw ApiException(0, "That server address isn't a valid http(s) URL.")
        val request = Request.Builder()
            .url(url)
            .header("Authorization", "Bearer $token")
            .header("X-Alongside-Client", CLIENT)
            .method(method, body?.toString()?.toRequestBody(JSON))
            .build()
        client.newCall(request).execute().use { response ->
            val text = response.body?.string().orEmpty()
            if (!response.isSuccessful) throw refusal(response.code, text)
            text
        }
    }

    /** The v2 error envelope is `{error:{code,message,…}}`; unversioned gateways send `{error:"…"}`. */
    private fun refusal(status: Int, text: String): ApiException {
        val error = runCatching { json.parseToJsonElement(text).jsonObject["error"] }.getOrNull()
        val detail = error as? JsonObject
        val message = runCatching { detail?.get("message")?.jsonPrimitive?.content ?: error?.jsonPrimitive?.content }.getOrNull()
        val current = runCatching {
            val entity = (detail?.get("currentEntity") ?: detail?.get("currentLink")) as? JsonObject
            (entity?.get("version") as? JsonObject)?.get("revision")?.jsonPrimitive?.longOrNull
        }.getOrNull()
        val friendly = when (status) {
            401 -> "The server didn't accept that token."
            in 500..599 -> "The server ran into a problem."
            else -> message ?: "The server answered $status."
        }
        val code = runCatching { detail?.get("code")?.jsonPrimitive?.content }.getOrNull()
        return ApiException(status, friendly, code, current, syncReset = detail?.get("syncReset") != null)
    }

    companion object {
        private const val UNREADABLE = "The server sent something this app couldn't read."
        private const val CLIENT = "android/1"
        val json = Json { ignoreUnknownKeys = true; explicitNulls = true; encodeDefaults = true }
        private val JSON = "application/json".toMediaType()
        private val client = OkHttpClient.Builder()
            .connectTimeout(10, TimeUnit.SECONDS)
            .readTimeout(20, TimeUnit.SECONDS)
            .build()
    }
}
