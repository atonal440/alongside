package com.atonal440.alongside.data.ai

import com.google.mlkit.genai.common.DownloadStatus
import com.google.mlkit.genai.common.FeatureStatus
import com.google.mlkit.genai.prompt.Generation
import com.google.mlkit.genai.prompt.TextPart
import com.google.mlkit.genai.prompt.generateContentRequest
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.map
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject

/** What the language model fills in. Dates, times and repeats come from the parser, never from here. */
data class ModelFields(val title: String, val notes: String?, val plan: Boolean)

/** The model's reply is free text that should contain one JSON object; this is the strict reader for it. */
object ModelReply {
    private val json = Json { isLenient = true }

    fun parse(text: String): ModelFields? {
        // Small models like a ```json fence and a sentence of preamble; take the outermost braces.
        val start = text.indexOf('{')
        val end = text.lastIndexOf('}')
        if (start < 0 || end <= start) return null
        val obj = runCatching { json.parseToJsonElement(text.substring(start, end + 1)).jsonObject }.getOrNull() ?: return null
        val title = obj.string("title")?.trim()?.takeIf { it.isNotEmpty() } ?: return null
        // Nano sometimes drops task_type (seen on a Pixel 10); a task is an action unless the model says plan.
        val plan = obj.string("task_type")?.trim().equals("plan", ignoreCase = true)
        return ModelFields(title, obj.string("notes")?.trim()?.takeIf { it.isNotEmpty() && !it.equals("none", true) && !it.equals("null", true) }, plan)
    }

    private fun JsonObject.string(key: String): String? = (this[key] as? JsonPrimitive)?.takeIf { it !is JsonNull }?.contentOrNull
}

object QuickAddPrompt {
    /** [rest] is the entry with its dates, times and repeats already cut out by `QuickAddParser`. */
    fun build(rest: String): String = """
        You turn one line of casual speech into a task for a task manager.
        Dates, times and repeats are handled elsewhere, so ignore them.

        Fields:
        - title: short imperative phrase.
        - notes: extra detail that does not belong in the title, otherwise null.
        - task_type: "plan" if the task is a goal that needs breaking down, otherwise "action".

        Reply with a single JSON object and nothing else, like this:
        Entry: return Sam's drill
        {"title":"Return Sam's drill","notes":null,"task_type":"action"}

        Entry: $rest
    """.trimIndent()
}

enum class ModelAvailability { Available, Downloadable, Downloading, Unavailable }

data class ModelOutcome(
    val fields: ModelFields?,
    /** The last reply, kept so a misparse can be read on the phone. */
    val raw: String,
    val millis: Long,
    val attempts: Int,
    val error: String? = null,
)

/**
 * Gemini Nano through AICore via the ML Kit GenAI Prompt API (beta). The model is a system service: it can be
 * missing, still downloading, or unsupported (not a Pixel 9+ class phone, unlocked bootloader), so everything
 * here reports instead of throwing and the caller keeps working without it.
 */
class OnDeviceQuickAdd {
    private val model by lazy { Generation.getClient() }

    suspend fun availability(): Pair<ModelAvailability, String?> = try {
        when (model.checkStatus()) {
            FeatureStatus.AVAILABLE -> {
                // Loads Nano into memory now so the first real call is not the slow one.
                runCatching { model.warmup() }
                ModelAvailability.Available to null
            }
            FeatureStatus.DOWNLOADABLE -> ModelAvailability.Downloadable to null
            FeatureStatus.DOWNLOADING -> ModelAvailability.Downloading to null
            else -> ModelAvailability.Unavailable to "AICore reports the feature as unavailable on this device."
        }
    } catch (e: Exception) {
        ModelAvailability.Unavailable to (e.message ?: e::class.java.simpleName)
    }

    /** Emits a short progress line per update; completes when the download is done or has failed. */
    fun download(): Flow<String> = model.download().map { status ->
        when (status) {
            is DownloadStatus.DownloadStarted -> "Download started"
            is DownloadStatus.DownloadProgress -> "${status.totalBytesDownloaded / 1_000_000} MB downloaded"
            is DownloadStatus.DownloadCompleted -> "Download complete"
            is DownloadStatus.DownloadFailed -> "Download failed: ${status.e.message}"
            else -> status.toString()
        }
    }

    /** Runs the model on [rest], retrying once on a reply that does not parse (the second try is slightly warmer). */
    suspend fun interpret(rest: String): ModelOutcome {
        val started = System.nanoTime()
        var raw = ""
        var attempts = 0
        var error: String? = null
        for (temp in floatArrayOf(0f, 0.3f)) {
            attempts++
            try {
                val response = model.generateContent(
                    generateContentRequest(TextPart(QuickAddPrompt.build(rest))) {
                        temperature = temp
                        topK = 1
                        candidateCount = 1
                        maxOutputTokens = 160
                    },
                )
                raw = response.candidates.firstOrNull()?.text.orEmpty()
                ModelReply.parse(raw)?.let { return ModelOutcome(it, raw, millisSince(started), attempts) }
                error = "The reply was not the JSON the app asked for."
            } catch (e: Exception) {
                error = e.message ?: e::class.java.simpleName
                break
            }
        }
        return ModelOutcome(null, raw, millisSince(started), attempts, error)
    }

    private fun millisSince(startNanos: Long) = (System.nanoTime() - startNanos) / 1_000_000
}
