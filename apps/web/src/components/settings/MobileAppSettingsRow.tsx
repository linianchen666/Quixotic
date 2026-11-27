import { T, useGT } from "gt-react";
import { SmartphoneIcon } from "lucide-react";
import { MOBILE_APP_URL } from "~/branding";

import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "../ui/popover";
import { QRCodeSvg } from "../ui/qr-code";
import { SettingsRow } from "./settingsLayout";
import { useSearchableSetting } from "./settingsSearch";

export function MobileAppSettingsRow() {
  const searchableSetting = useSearchableSetting();
  const gt = useGT();
  return (
    <SettingsRow
      {...searchableSetting("mobile-app")}
      description={gt("Find companion builds in Quixotic releases. Pair your phone or tablet in Sharing & access.")}
      control={
        <Popover>
          <PopoverTrigger render={<Button size="sm" variant="outline" />}>
            <SmartphoneIcon />
            <T>Project releases</T>
          </PopoverTrigger>
          <PopoverPopup align="end">
            <div className="flex flex-col items-center gap-3">
              <PopoverTitle><T>Quixotic releases</T></PopoverTitle>
              <p className="text-xs text-muted-foreground">
                <T>Scan with your phone camera.</T>
              </p>
              <div className="rounded-lg bg-white p-1.5">
                <QRCodeSvg
                  value={MOBILE_APP_URL}
                  size={128}
                  level="M"
                  marginSize={1}
                  title={gt("Quixotic releases")}
                />
              </div>
              <Button
                size="sm"
                variant="outline"
                render={<a href={MOBILE_APP_URL} target="_blank" rel="noreferrer noopener" />}
              >
                <T>Open project releases</T>
              </Button>
            </div>
          </PopoverPopup>
        </Popover>
      }
    />
  );
}
