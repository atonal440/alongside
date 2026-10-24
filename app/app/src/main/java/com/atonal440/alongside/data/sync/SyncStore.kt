package com.atonal440.alongside.data.sync

import com.atonal440.alongside.data.AlongsideApi
import com.atonal440.alongside.data.Workspace
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.encodeToJsonElement
import kotlinx.serialization.json.jsonObject
import java.io.File
import java.io.IOException

/** The canonical workspace on disk: derived cache, so anything unreadable just reads as a miss. */
@Serializable
data class CanonicalFile(val source: String, val cursor: SyncCursor, val images: List<SyncImage>)

/** The two files the sync engine owns. Writes are atomic per file and throw [IOException] on failure. */
interface SyncStore {
    fun loadState(): SyncState?
    fun saveState(state: SyncState)
    fun loadCanonical(): CanonicalFile?
    fun saveCanonical(file: CanonicalFile)
    fun clear()
}

class FileSyncStore(private val dir: File) : SyncStore {
    private val stateFile = File(dir, "sync_state.json")
    private val canonicalFile = File(dir, "canonical.json")

    init {
        // Files from the legacy-endpoint queue this store replaced; nothing reads them any more.
        listOf("workspace.json", "pending_ops.json", "set_aside_ops.json").forEach { File(dir, it).delete() }
    }

    override fun loadState(): SyncState? = read(stateFile) { AlongsideApi.json.decodeFromString<SyncState>(it) }

    override fun saveState(state: SyncState) = writeAtomically(stateFile, AlongsideApi.json.encodeToString(SyncState.serializer(), state))

    override fun loadCanonical(): CanonicalFile? = read(canonicalFile) { AlongsideApi.json.decodeFromString<CanonicalFile>(it) }

    override fun saveCanonical(file: CanonicalFile) =
        writeAtomically(canonicalFile, AlongsideApi.json.encodeToString(CanonicalFile.serializer(), file))

    override fun clear() {
        stateFile.delete()
        canonicalFile.delete()
    }

    /** An unreadable file is set aside (not deleted) so a bug can't silently eat the queue. */
    private fun <T> read(file: File, decode: (String) -> T): T? {
        if (!file.exists()) return null
        return try {
            decode(file.readText())
        } catch (e: Exception) {
            file.renameTo(File(dir, file.name + ".unreadable"))
            null
        }
    }

    /** Write to a sibling temp file, then rename over the target, so a reader never sees half a file. */
    private fun writeAtomically(target: File, text: String) {
        val temp = File(dir, target.name + ".tmp")
        temp.writeText(text)
        if (!temp.renameTo(target)) {
            target.delete()
            if (!temp.renameTo(target)) throw IOException("Couldn't write ${target.name}.")
        }
    }
}

/** For tests and as a stand-in before the app has a files directory. */
class MemorySyncStore : SyncStore {
    var state: SyncState? = null
    var canonical: CanonicalFile? = null
    override fun loadState() = state
    override fun saveState(state: SyncState) { this.state = state }
    override fun loadCanonical() = canonical
    override fun saveCanonical(file: CanonicalFile) { canonical = file }
    override fun clear() { state = null; canonical = null }
}

/**
 * The sample workspace as canonical images (revision 1 each), so sample mode runs through the
 * same overlay and queue as a real server. It is rebuilt on every start and never stored.
 */
fun canonicalFromWorkspace(ws: Workspace): CanonicalWorkspace {
    val json = AlongsideApi.json
    val images = ArrayList<SyncImage>()
    ws.projects.mapTo(images) { SyncImage("project", it.id, 1, row = json.encodeToJsonElement(it).jsonObject) }
    ws.tasks.mapTo(images) { SyncImage("task", it.id, 1, row = json.encodeToJsonElement(it).jsonObject) }
    ws.links.mapTo(images) { SyncImage("link", linkKey(it.from_task_id, it.to_task_id, it.link_type), 1, row = json.encodeToJsonElement(it).jsonObject) }
    return CanonicalWorkspace(SyncCursor(1, 1), images.associateBy { it.id })
}
