export const HOST_POLICY = {
  connect: [
    "brouter.de",
    "overpass.private.coffee",
    "overpass-api.de",
    "elevation-tiles-prod.s3.amazonaws.com",
  ],
  img: ["tile.openstreetmap.org", "*.tile-cyclosm.openstreetmap.fr"],
  external: [
    "www.google.com",
    "drive.google.com",
    "onedrive.live.com",
    "www.openstreetmap.org",
    "www.cyclosm.org",
  ],
  namespaces: ["www.opengis.net", "www.topografix.com"],
  credits: ["opendatacommons.org"],
  removedWithGoatCounter: ["szapalak.goatcounter.com"],
} as const;
