package com.atonal440.alongside.data

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject

/**
 * A write the worker hasn't confirmed yet. Ops are stored on disk in order and replayed until
 * the server either accepts them or refuses them for good, so a change made offline survives
 * restarts instead of being overwritten by the next pull.
 *
 * Ids may be local placeholders (`local_…`) for tasks created offline; replay maps them to the
 * server's ids as their creates land.
 */
@Serializable
sealed interface PendingOp {
    @Serializable @SerialName("create")
    data class Create(val localId: String, val body: JsonObject) : PendingOp

    @Serializable @SerialName("patch")
    data class Patch(val taskId: String, val body: JsonObject) : PendingOp

    @Serializable @SerialName("complete")
    data class Complete(val taskId: String) : PendingOp

    @Serializable @SerialName("reopen")
    data class Reopen(val taskId: String, val spawnedId: String?) : PendingOp

    @Serializable @SerialName("delete")
    data class Delete(val taskId: String) : PendingOp
}

const val LOCAL_ID_PREFIX = "local_"

/** Network trouble and server hiccups are worth retrying; a 4xx refusal is final. */
fun Throwable.isTransient(): Boolean = when (this) {
    is ApiException -> status >= 500 || status == 408 || status == 429
    else -> true
}
