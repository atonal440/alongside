package com.atonal440.alongside.data

import android.content.Context
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

/** Where the worker lives and who's asking. Plain prefs: the token never leaves the device. */
data class Settings(
    val serverUrl: String = "",
    val token: String = "",
    val name: String = "",
    val sampleMode: Boolean = false,
) {
    val isConnected get() = serverUrl.isNotBlank() && token.isNotBlank()
    val isConfigured get() = sampleMode || isConnected

    companion object {
        private const val PREFS = "alongside_settings"

        /**
         * The address as it will be saved: trimmed, `https://` assumed when no scheme is given,
         * trailing slash dropped. Null when it still isn't an http(s) URL with a host.
         */
        fun normalizeServerUrl(raw: String): String? {
            val trimmed = raw.trim().trimEnd('/')
            if (trimmed.isEmpty()) return null
            val withScheme = if ("://" in trimmed) trimmed else "https://$trimmed"
            val url = withScheme.toHttpUrlOrNull() ?: return null
            return if (url.host.isBlank()) null else withScheme
        }

        fun load(context: Context): Settings {
            val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            return Settings(
                serverUrl = prefs.getString("server_url", "").orEmpty(),
                token = prefs.getString("token", "").orEmpty(),
                name = prefs.getString("name", "").orEmpty(),
                sampleMode = prefs.getBoolean("sample_mode", false),
            )
        }

        fun save(context: Context, settings: Settings) {
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                .putString("server_url", settings.serverUrl.trim())
                .putString("token", settings.token.trim())
                .putString("name", settings.name.trim())
                .putBoolean("sample_mode", settings.sampleMode)
                .apply()
        }
    }
}
