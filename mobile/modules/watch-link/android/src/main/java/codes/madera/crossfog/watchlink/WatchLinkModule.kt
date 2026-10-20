package codes.madera.crossfog.watchlink

import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class WatchLinkModule : Module() {
  private val keys by lazy {
    Keys(appContext.reactContext ?: throw CodedException("ERR_NO_CONTEXT", "no Android context", null))
  }

  override fun definition() = ModuleDefinition {
    Name("WatchLink")

    AsyncFunction("getDatabaseKeyHex") {
      try {
        keys.databaseKey().joinToString("") { "%02x".format(it) }
      } catch (e: KeyLostException) {
        throw CodedException(KEY_LOST, e.message, e)
      }
    }

    AsyncFunction("keyState") { keys.keyState().wire }
  }

  private companion object {
    const val KEY_LOST = "ERR_KEY_LOST"
  }
}
