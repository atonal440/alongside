package com.atonal440.alongside.data

import android.content.Context

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
