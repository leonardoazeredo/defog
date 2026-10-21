package codes.madera.crossfog.watchlink

import expo.modules.kotlin.modules.ModuleDefinitionBuilder

// Debug builds only: the release source set has an empty twin, so the name never reaches a release dex.
internal fun ModuleDefinitionBuilder.debugFunctions(stage: (ByteArray) -> Unit) {
  AsyncFunction("stageForTest") { offerJson: String -> stage(offerJson.toByteArray(Charsets.UTF_8)) }
}
