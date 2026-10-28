import { ScrollView, StyleSheet, Text, View } from "react-native";
import licenses from "../../generated/licenses.json";

const APP_VERSION = "0.1.0";

// Verbatim from tilezen/joerd docs/attribution.md, its "Required attribution:" list (not the
// Mapzen-hosted one), so it can be re-diffed against that file when the providers update it.
const TERRAIN_ATTRIBUTION = [
  "ArcticDEM terrain data DEM(s) were created from DigitalGlobe, Inc., imagery and funded under National Science Foundation awards 1043681, 1559691, and 1542736;",
  "Australia terrain data © Commonwealth of Australia (Geoscience Australia) 2017;",
  "Austria terrain data © offene Daten Österreichs – Digitales Geländemodell (DGM) Österreich;",
  "Canada terrain data contains information licensed under the Open Government Licence – Canada;",
  "Europe terrain data produced using Copernicus data and information funded by the European Union - EU-DEM layers;",
  "Global ETOPO1 terrain data U.S. National Oceanic and Atmospheric Administration",
  "Mexico terrain data source: INEGI, Continental relief, 2016;",
  "New Zealand terrain data Copyright 2011 Crown copyright (c) Land Information New Zealand and the New Zealand Government (All rights reserved);",
  "Norway terrain data © Kartverket;",
  "United Kingdom terrain data © Environment Agency copyright and/or database right 2015. All rights reserved;",
  "United States 3DEP (formerly NED) and global GMTED2010 and SRTM terrain data courtesy of the U.S. Geological Survey.",
];

export default function AboutScreen() {
  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.appName}>Cross the Fog</Text>
      <Text style={styles.version}>Version {APP_VERSION}</Text>

      <Section title="defog">
        <Text style={styles.body}>
          This app embeds <Text style={styles.bold}>defog</Text> — a privacy-first fog-of-war map
          built by szalapak.
        </Text>
        <LicenseBlock text={licenses.defog} />
      </Section>

      <Section title="Map tiles">
        <Text style={styles.body}>
          Map data © <Text style={styles.bold}>OpenStreetMap</Text> contributors, available under
          the Open Database Licence. Cartography © OpenStreetMap Foundation.
        </Text>
      </Section>

      <Section title="Terrain tiles">
        <Text style={styles.body}>
          Elevation from the <Text style={styles.bold}>AWS Open Data terrain tiles</Text>{" "}
          (registry.opendata.aws/terrain-tiles), which combine public elevation data. Attribution
          for the sources they combine:
        </Text>
        {TERRAIN_ATTRIBUTION.map((line) => (
          <Text key={line} style={styles.body}>
            {line}
          </Text>
        ))}
      </Section>

      <Section title="Leaflet">
        <Text style={styles.body}>
          Interactive maps powered by <Text style={styles.bold}>Leaflet</Text>.
        </Text>
        <LicenseBlock text={licenses.leaflet} />
      </Section>

      <Section title="pako">
        <Text style={styles.body}>
          ZIP decompression via <Text style={styles.bold}>pako</Text>.
        </Text>
        <LicenseBlock text={licenses.pako} />
      </Section>

      <Section title="BRouter">
        <Text style={styles.body}>
          Distance, ascent and time estimates follow the model of{" "}
          <Text style={styles.bold}>BRouter</Text>.
        </Text>
        <LicenseBlock text={licenses.brouter} />
      </Section>

      <Section title="Open-source dependencies">
        <Text style={styles.body}>
          This app is built on {licenses.dependencies.length} open-source packages. A full list with
          SPDX license identifiers:
        </Text>
        <View style={styles.depTable}>
          {licenses.dependencies.map((d) => (
            <View key={`${d.name}@${d.version}`} style={styles.depRow}>
              <Text style={styles.depName}>{d.name}</Text>
              <Text style={styles.depVersion}>{d.version}</Text>
              <Text style={styles.depLicense}>{d.license}</Text>
            </View>
          ))}
        </View>
      </Section>
    </ScrollView>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {children}
    </View>
  );
}

function LicenseBlock({ text }: { text: string }) {
  return <Text style={styles.licenseBlock}>{text}</Text>;
}

const styles = StyleSheet.create({
  container: {
    padding: 16,
    paddingBottom: 40,
  },
  appName: {
    fontSize: 24,
    fontWeight: "700",
    marginBottom: 4,
  },
  version: {
    fontSize: 14,
    color: "#666",
    marginBottom: 24,
  },
  section: {
    marginBottom: 28,
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: "600",
    marginBottom: 8,
  },
  body: {
    fontSize: 14,
    lineHeight: 20,
    color: "#333",
    marginBottom: 8,
  },
  bold: {
    fontWeight: "600",
  },
  licenseBlock: {
    fontSize: 11,
    lineHeight: 16,
    color: "#555",
    fontFamily: "monospace",
    backgroundColor: "#f5f5f5",
    padding: 8,
    borderRadius: 4,
  },
  depTable: {
    marginTop: 8,
  },
  depRow: {
    flexDirection: "row",
    paddingVertical: 3,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#e0e0e0",
    gap: 8,
  },
  depName: {
    flex: 3,
    fontSize: 12,
    color: "#333",
  },
  depVersion: {
    flex: 2,
    fontSize: 12,
    color: "#666",
  },
  depLicense: {
    flex: 2,
    fontSize: 12,
    color: "#888",
  },
});
