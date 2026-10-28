package codes.madera.crossfog.watchlink

import java.io.IOException

/**
 * What the staging store holds: the walks that read back whole, and how many items did not
 * (they fail to authenticate, as every item sealed before a lost staging alias does, or do not
 * parse or match their file name). Those stay on disk: each is the only copy the watch gave up.
 */
internal class StagedActivities(val readable: List<ActivityOffer>, val unreadable: Int)

/** A Keystore failure is not caught, so it propagates to the caller instead of counting every item. */
internal fun readStagedActivities(store: StagingStore): StagedActivities {
  val readable = mutableListOf<ActivityOffer>()
  var unreadable = 0
  for (id in store.list()) {
    val item = try {
      store.read(id)?.let { Frames.parseActivityOffer(it) }?.takeIf { it.activityId == id }
    } catch (e: FrameException) {
      null
    } catch (e: IOException) {
      null
    }
    if (item == null) unreadable++ else readable += item
  }
  return StagedActivities(readable, unreadable)
}
