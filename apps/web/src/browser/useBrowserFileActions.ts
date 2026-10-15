import { mediaFileReference } from "@t3tools/client-runtime/media-reference";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  AuthFilesystemReadScope,
  AuthPreviewOperateScope,
  type EnvironmentId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { resolvePathLinkTarget } from "@t3tools/shared/fileLinks";
import { useCallback, useMemo } from "react";

import { resolveAssetUrl } from "~/assets/assetUrls";
import { isPreviewAvailableFor } from "~/browser/previewRuntime";
import { openUrlInPreview } from "~/browser/openFileInPreview";
import { toastManager } from "~/components/ui/toast";
import { writeTextToClipboard } from "~/hooks/useCopyToClipboard";
import { readLocalApi } from "~/localApi";
import { assetEnvironment } from "~/state/assets";
import { previewEnvironment } from "~/state/preview";
import { readEnvironmentScope, useEnvironmentScope, usePreparedConnection } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";
import { useAtomQueryRunner } from "~/state/use-atom-query-runner";

export const isHtmlFile = (path: string): boolean =>
  /\.html?$/i.test(path.split(/[?#]/, 1)[0] ?? "");

/** Browser URLs use the environment's asset service so sibling CSS, images and scripts still load. */
export function useBrowserFileActions(
  environmentId: EnvironmentId | null,
  workspaceRoot: string | undefined,
  threadRef?: ScopedThreadRef,
) {
  const connection = usePreparedConnection(environmentId);
  const canReadFiles = useEnvironmentScope(environmentId, AuthFilesystemReadScope);
  const canOperatePreview = useEnvironmentScope(environmentId, AuthPreviewOperateScope);
  const createUrl = useAtomQueryRunner(assetEnvironment.createUrl, {
    reportFailure: false,
    refresh: true,
  });
  const openPreview = useAtomCommand(previewEnvironment.open, { reportFailure: false });
  const canOpen =
    canReadFiles &&
    environmentId !== null &&
    connection._tag === "Some" &&
    (threadRef !== undefined || workspaceRoot !== undefined);
  const canOpenIntegrated =
    canOpen &&
    threadRef !== undefined &&
    canOperatePreview &&
    isPreviewAvailableFor(threadRef.environmentId);

  const getUrl = useCallback(
    async (filePath: string) => {
      if (
        !canOpen ||
        environmentId === null ||
        !readEnvironmentScope(environmentId, AuthFilesystemReadScope)
      ) {
        throw new Error("Environment is not connected or file access is unavailable.");
      }
      const absolutePath = workspaceRoot
        ? resolvePathLinkTarget(filePath, workspaceRoot)
        : filePath;
      const insideWorkspace =
        mediaFileReference(absolutePath, workspaceRoot).relativePath !== undefined;
      if (!threadRef && workspaceRoot === undefined) throw new Error("Workspace is unavailable.");
      const resource = threadRef
        ? {
            _tag: insideWorkspace ? ("workspace-file" as const) : ("media-file" as const),
            threadId: threadRef.threadId,
            path: absolutePath,
          }
        : { _tag: "draft-workspace-file" as const, cwd: workspaceRoot ?? "", path: absolutePath };
      const result = await createUrl({ environmentId, input: { resource } });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      const url = resolveAssetUrl(connection.value.httpBaseUrl, result.value.relativeUrl);
      if (url === null || !/^https?:\/\//i.test(url))
        throw new Error("The environment returned an invalid browser URL.");
      return url;
    },
    [canOpen, connection, createUrl, environmentId, threadRef, workspaceRoot],
  );

  const activate = useCallback(
    async (filePath: string, action: "integrated" | "external" | "copy") => {
      let tab: Window | null = null;
      try {
        if (
          !canOpen ||
          environmentId === null ||
          !readEnvironmentScope(environmentId, AuthFilesystemReadScope)
        ) {
          throw new Error("File access is unavailable.");
        }
        // Reserve a tab during the gesture, before asynchronous URL signing loses user activation.
        if (action === "external" && !window.desktopBridge) {
          tab = window.open("about:blank", "_blank");
          if (tab) tab.opener = null;
        }
        if (action === "integrated" && !canOpenIntegrated)
          throw new Error("The T3 browser is unavailable.");
        if (action === "external" && !window.desktopBridge && !tab)
          throw new Error("Allow pop-ups to open this file in a browser tab.");
        const url = await getUrl(filePath);
        if (
          !readEnvironmentScope(environmentId, AuthFilesystemReadScope) ||
          (action === "integrated" && !readEnvironmentScope(environmentId, AuthPreviewOperateScope))
        ) {
          throw new Error("File access is unavailable.");
        }
        if (tab?.closed) return;
        if (action === "copy") {
          await writeTextToClipboard(url);
          toastManager.add({ type: "success", title: "Browser URL copied" });
        } else if (action === "external") {
          if (tab) tab.location.replace(url);
          else {
            const api = readLocalApi();
            if (!api) throw new Error("Unable to open browser.");
            await api.shell.openExternal(url);
          }
        } else if (threadRef) {
          const result = await openUrlInPreview({ threadRef, url, openPreview });
          if (result._tag === "Failure") throw squashAtomCommandFailure(result);
        }
      } catch (error) {
        tab?.close();
        toastManager.add({
          type: "error",
          title: action === "copy" ? "Unable to copy browser URL" : "Unable to open HTML file",
          description: error instanceof Error ? error.message : "An error occurred.",
        });
      }
    },
    [canOpen, canOpenIntegrated, environmentId, getUrl, openPreview, threadRef],
  );
  return useMemo(
    () => ({ canOpen, canOpenIntegrated, activate }),
    [canOpen, canOpenIntegrated, activate],
  );
}
