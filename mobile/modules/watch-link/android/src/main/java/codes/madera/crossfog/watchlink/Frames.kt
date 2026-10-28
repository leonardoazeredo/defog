package codes.madera.crossfog.watchlink

import org.json.JSONException
import org.json.JSONObject

const val MAX_FRAME_BYTES = 16 * 1024 * 1024

/** A frame was malformed. The message never holds input, because it can reach JS and the crash log. */
class FrameException(message: String) : Exception(message)

data class ActivityOffer(
  val activityId: String,
  val routeId: String?,
  val travelMode: String,
  val encoderVersion: String,
  val gpx: String,
) {
  // The generated one would print the whole track into any log or crash report.
  override fun toString() = "ActivityOffer"

  /** What `pendingActivities` lists: the file stays behind `readActivity`. */
  fun summary(): Map<String, Any?> = buildMap {
    put("activityId", activityId)
    if (routeId != null) put("routeId", routeId)
    put("travelMode", travelMode)
    put("encoderVersion", encoderVersion)
  }
}

data class RouteOffer(
  val routeId: String,
  val name: String,
  val travelMode: String,
  val createdAt: String,
  val gpx: String,
) {
  override fun toString() = "RouteOffer"
}

object Frames {
  fun parseActivityOffer(bytes: ByteArray): ActivityOffer {
    val o = parseObject(bytes)
    return ActivityOffer(
      activityId = o.uuid("activityId"),
      routeId = if (o.isMissing("routeId")) null else o.uuid("routeId"),
      travelMode = o.text("travelMode", 32),
      encoderVersion = o.text("encoderVersion", 64),
      gpx = o.text("gpx", MAX_FRAME_BYTES),
    )
  }

  fun parseRouteOffer(bytes: ByteArray): RouteOffer {
    val o = parseObject(bytes)
    return RouteOffer(
      routeId = o.uuid("routeId"),
      name = o.text("name", 255),
      travelMode = o.text("travelMode", 32),
      createdAt = o.text("createdAt", 64),
      gpx = o.text("gpx", MAX_FRAME_BYTES),
    )
  }

  private fun parseObject(bytes: ByteArray): JSONObject {
    if (bytes.size > MAX_FRAME_BYTES) throw FrameException("frame is too large")
    // org.json puts the whole input into its syntax-error message, so the cause is dropped.
    return try {
      JSONObject(String(bytes, Charsets.UTF_8))
    } catch (e: JSONException) {
      throw FrameException("frame is not a JSON object")
    } catch (e: StackOverflowError) {
      // org.json recurses, so a deeply nested frame must not take the process down.
      throw FrameException("frame is nested too deeply")
    }
  }

  private fun JSONObject.isMissing(key: String) = !has(key) || isNull(key)

  // opt, not getString: getString turns a number into its text.
  private fun JSONObject.text(key: String, maxLength: Int): String {
    val value = opt(key) as? String
    if (value.isNullOrEmpty() || value.length > maxLength) throw FrameException("field $key is missing or invalid")
    return value
  }

  private fun JSONObject.uuid(key: String): String {
    val value = text(key, 36)
    // The id form StagingStore takes, so a frame accepted here is never refused when staged.
    if (!UUID_ID.matches(value)) throw FrameException("field $key is missing or invalid")
    return value
  }
}
