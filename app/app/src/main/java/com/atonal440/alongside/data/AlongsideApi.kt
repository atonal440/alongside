package com.atonal440.alongside.data

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.util.concurrent.TimeUnit

class ApiException(val status: Int, message: String) : IOException(message)

/**
 * Thin client over the legacy v1 REST endpoints. The Android client sends no
 * `Origin`, so the worker's PWA protocol gate does not apply to it.
 */
class AlongsideApi(baseUrl: String, private val token: String) {
    private val base = baseUrl.trimEnd('/')

    suspend fun allTasks(): List<Task> = get("/api/tasks/sync")
    suspend fun allProjects(): List<Project> = get("/api/projects/sync")
    suspend fun links(): List<TaskLink> = get("/api/tasks/links")

    suspend fun createTask(body: JsonObject): Task = send("POST", "/api/tasks", body)
    suspend fun updateTask(id: String, body: JsonObject): Task = send("PATCH", "/api/tasks/$id", body)
    suspend fun completeTask(id: String): CompleteResult = send("POST", "/api/tasks/$id/complete", JsonObject(emptyMap()))
    suspend fun deleteTask(id: String) {
        call<JsonElement>("DELETE", "/api/tasks/$id", null)
    }

    private suspend inline fun <reified T> get(path: String): T = call("GET", path, null)
    private suspend inline fun <reified T> send(method: String, path: String, body: JsonObject): T = call(method, path, body)

    private suspend inline fun <reified T> call(method: String, path: String, body: JsonObject?): T =
        withContext(Dispatchers.IO) {
            val url = (base + path).toHttpUrlOrNull()
                ?: throw ApiException(0, "That server address isn't a valid http(s) URL.")
            val request = Request.Builder()
                .url(url)
                .header("Authorization", "Bearer $token")
                .method(method, body?.toString()?.toRequestBody(JSON))
                .build()
            client.newCall(request).execute().use { response ->
                val text = response.body?.string().orEmpty()
                if (!response.isSuccessful) throw ApiException(response.code, errorMessage(response.code, text))
                try {
                    json.decodeFromString<T>(text)
                } catch (e: SerializationException) {
                    // A reply this client can't read is final, not a network blip; surface it
                    // as an error instead of letting it crash the app.
                    throw ApiException(0, "The server sent something this app couldn't read.")
                }
            }
        }

    private fun errorMessage(code: Int, text: String): String {
        val detail = runCatching {
            val error = json.parseToJsonElement(text).jsonObject["error"]
            (error as? JsonObject)?.get("message")?.jsonPrimitive?.content ?: error?.jsonPrimitive?.content
        }.getOrNull()
        return when (code) {
            401 -> "The server didn't accept that token."
            else -> detail ?: "The server answered $code."
        }
    }

    companion object {
        val json = Json { ignoreUnknownKeys = true; explicitNulls = true; encodeDefaults = true }
        private val JSON = "application/json".toMediaType()
        private val client = OkHttpClient.Builder()
            .connectTimeout(10, TimeUnit.SECONDS)
            .readTimeout(20, TimeUnit.SECONDS)
            .build()
    }
}
