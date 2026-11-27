import {
  DesktopDataDirectoryMigrateInputSchema,
  DesktopDataDirectoryMigrateResultSchema,
  DesktopDataDirectoryStateSchema,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopDataDirectory from "../../app/DesktopDataDirectory.ts";
import * as DesktopLifecycle from "../../app/DesktopLifecycle.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

export const getDataDirectoryState = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.GET_DATA_DIRECTORY_STATE_CHANNEL,
  payload: Schema.Void,
  result: DesktopDataDirectoryStateSchema,
  handler: Effect.fn("desktop.ipc.dataDirectory.getState")(function* () {
    const dataDirectory = yield* DesktopDataDirectory.DesktopDataDirectory;
    return yield* dataDirectory.getState;
  }),
});

export const migrateDataDirectory = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.MIGRATE_DATA_DIRECTORY_CHANNEL,
  payload: DesktopDataDirectoryMigrateInputSchema,
  result: DesktopDataDirectoryMigrateResultSchema,
  handler: Effect.fn("desktop.ipc.dataDirectory.migrate")(function* (input) {
    const lifecycle = yield* DesktopLifecycle.DesktopLifecycle;
    const dataDirectory = yield* DesktopDataDirectory.DesktopDataDirectory;
    const result = yield* dataDirectory.migrate(input);
    if (result.ok && result.relaunching) {
      yield* lifecycle.relaunch(`data-directory-${input.mode}`);
    }
    return result;
  }),
});

export const openDataDirectory = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.OPEN_DATA_DIRECTORY_CHANNEL,
  payload: Schema.Void,
  result: Schema.Boolean,
  handler: Effect.fn("desktop.ipc.dataDirectory.openFolder")(function* () {
    const dataDirectory = yield* DesktopDataDirectory.DesktopDataDirectory;
    return yield* dataDirectory.openFolder;
  }),
});
