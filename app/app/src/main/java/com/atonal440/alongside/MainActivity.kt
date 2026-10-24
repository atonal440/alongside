package com.atonal440.alongside

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import com.atonal440.alongside.ui.AlongsideApp
import com.atonal440.alongside.ui.AppViewModel
import com.atonal440.alongside.ui.theme.AlongsideTheme

class MainActivity : ComponentActivity() {
    private val vm: AppViewModel by viewModels()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        if (savedInstanceState == null) handle(intent)
        setContent {
            AlongsideTheme {
                AlongsideApp(vm)
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handle(intent)
    }

    override fun onResume() {
        super.onResume()
        vm.repo.refreshInBackground()
    }

    /** Widgets launch the app with one of these extras. */
    private fun handle(intent: Intent?) {
        intent ?: return
        if (intent.getBooleanExtra(EXTRA_NEW_TASK, false)) vm.newTaskRequested.value = true
        intent.getStringExtra(EXTRA_TASK_ID)?.let(vm::open)
    }

    companion object {
        const val EXTRA_NEW_TASK = "com.atonal440.alongside.NEW_TASK"
        const val EXTRA_TASK_ID = "com.atonal440.alongside.TASK_ID"
    }
}
