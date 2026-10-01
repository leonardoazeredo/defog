export const HOST_POLICY = {
  connect: ["brouter.de", "overpass-api.de"],
  img: ["tile.openstreetmap.org", "*.tile-cyclosm.openstreetmap.fr"],
  external: ["www.google.com", "drive.google.com", "onedrive.live.com"],
  namespaces: ["www.opengis.net", "www.topografix.com"],
  removedWithGoatCounter: ["szapalak.goatcounter.com"],
} as const;
