import { T } from "gt-react";
import { DESKTOP_DOWNLOAD_URL } from "~/branding";
import { cn } from "~/lib/utils";

import { CommandBlock } from "./CommandBlock";

export function InstallQuixoticCommands({
  command,
  className,
}: {
  readonly command: string;
  readonly className?: string;
}) {
  return (
    <div className={cn("space-y-2", className)}>
      <p className="text-xs text-muted-foreground">
        <T>
          <a
            className="underline underline-offset-2 hover:text-foreground"
            href={DESKTOP_DOWNLOAD_URL}
            target="_blank"
            rel="noreferrer noopener"
          >
            Download Quixotic
          </a>{" "}
          and enable the command in Settings, then run:
        </T>
      </p>
      <CommandBlock command={command} />
    </div>
  );
}
