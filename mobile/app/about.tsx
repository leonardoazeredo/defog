import { ScrollView, StyleSheet, Text, View } from "react-native";
import licenses from "../../generated/licenses.json";

const APP_VERSION = "0.1.0";

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
