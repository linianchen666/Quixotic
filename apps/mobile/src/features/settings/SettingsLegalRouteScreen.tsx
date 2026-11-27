import { useGT } from "gt-react-native";
import { SettingsLegalDocumentRouteScreen } from "./components/SettingsLegalDocumentRouteScreen";
import { SettingsScreen } from "./components/SettingsScreen";
import { AppText as Text } from "../../components/ui/AppText";
import { LEGAL_URL } from "./lib/legal-document-url";

export function SettingsLegalRouteScreen() {
  const gt = useGT();
  if (!LEGAL_URL) {
    return (
      <SettingsScreen title={gt("Legal", { $context: "legal documents page title" })}>
        <Text className="p-5 text-foreground-muted">{gt("No legal website is configured for this build.")}</Text>
      </SettingsScreen>
    );
  }
  return (
    <SettingsLegalDocumentRouteScreen
      documentName={gt("Legal", { $context: "legal documents page title" })}
      documentUrl={LEGAL_URL}
    />
  );
}
