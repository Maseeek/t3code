import { AuthPreviewOperateScope, EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { useEffect } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  createUrl: vi.fn(),
  openIntegrated: vi.fn(),
  openExternal: vi.fn(),
  copy: vi.fn(),
  toast: vi.fn(),
  canRead: true,
  canPreview: true,
  httpBaseUrl: "http://localhost:3773",
}));
vi.mock("~/state/session", () => ({
  usePreparedConnection: () => ({ _tag: "Some", value: { httpBaseUrl: state.httpBaseUrl } }),
  useEnvironmentScope: (_: unknown, scope: string) =>
    scope === AuthPreviewOperateScope ? state.canPreview : state.canRead,
  readEnvironmentScope: (_: unknown, scope: string) =>
    scope === AuthPreviewOperateScope ? state.canPreview : state.canRead,
}));
vi.mock("~/assets/assetUrls", async () => ({
  resolveAssetUrl: (await import("@t3tools/client-runtime/state/assets")).resolveAssetUrl,
}));
vi.mock("~/state/assets", () => ({ assetEnvironment: { createUrl: "createUrl" } }));
vi.mock("~/state/preview", () => ({ previewEnvironment: { open: "open" } }));
vi.mock("~/state/use-atom-query-runner", () => ({ useAtomQueryRunner: () => state.createUrl }));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("~/browser/previewRuntime", () => ({ isPreviewAvailableFor: () => true }));
vi.mock("~/browser/openFileInPreview", () => ({ openUrlInPreview: state.openIntegrated }));
vi.mock("~/hooks/useCopyToClipboard", () => ({ writeTextToClipboard: state.copy }));
vi.mock("~/components/ui/toast", () => ({ toastManager: { add: state.toast } }));
vi.mock("~/localApi", () => ({
  readLocalApi: () => ({ shell: { openExternal: state.openExternal } }),
}));

import { useBrowserFileActions } from "./useBrowserFileActions";

const threadRef = { environmentId: EnvironmentId.make("local"), threadId: ThreadId.make("thread") };
let actions: ReturnType<typeof useBrowserFileActions>;
let renderer: ReactTestRenderer;
function Harness({ draft = false }: { draft?: boolean }) {
  const value = useBrowserFileActions(
    threadRef.environmentId,
    "/work",
    draft ? undefined : threadRef,
  );
  useEffect(() => {
    actions = value;
  }, [value]);
  return null;
}
async function render(draft = false) {
  await act(async () => {
    renderer = create(<Harness draft={draft} />);
  });
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", { desktopBridge: {} });
  state.httpBaseUrl = "http://localhost:3773";
  state.canRead = true;
  state.canPreview = true;
  state.createUrl
    .mockReset()
    .mockResolvedValue(AsyncResult.success({ relativeUrl: "/api/assets/token/report.html" }));
  state.openIntegrated.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  state.openExternal.mockReset().mockResolvedValue(undefined);
  state.copy.mockReset().mockResolvedValue(undefined);
  state.toast.mockReset();
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  vi.unstubAllGlobals();
});

it("opens workspace HTML through T3 with a URL that retains sibling asset access", async () => {
  await render();
  await actions.activate("report.html", "integrated");
  expect(state.createUrl).toHaveBeenCalledWith({
    environmentId: threadRef.environmentId,
    input: {
      resource: { _tag: "workspace-file", threadId: threadRef.threadId, path: "/work/report.html" },
    },
  });
  expect(state.openIntegrated).toHaveBeenCalledWith(
    expect.objectContaining({
      threadRef,
      url: "http://localhost:3773/api/assets/token/report.html",
    }),
  );
  expect(state.openExternal).not.toHaveBeenCalled();
});
it("opens externally without needing permission to operate the T3 browser", async () => {
  state.canPreview = false;
  await render();
  expect(actions.canOpenIntegrated).toBe(false);
  await actions.activate("report.html", "external");
  expect(state.openExternal).toHaveBeenCalledWith(
    "http://localhost:3773/api/assets/token/report.html",
  );
  expect(state.openIntegrated).not.toHaveBeenCalled();
});
it("copies a usable browser URL without opening a browser", async () => {
  await render();
  await actions.activate("report.html", "copy");
  expect(state.copy).toHaveBeenCalledWith("http://localhost:3773/api/assets/token/report.html");
  expect(state.openIntegrated).not.toHaveBeenCalled();
  expect(state.openExternal).not.toHaveBeenCalled();
});
it("uses a standalone media resource for HTML outside the workspace", async () => {
  await render();
  await actions.activate("/tmp/report.html", "external");
  expect(state.createUrl).toHaveBeenCalledWith(
    expect.objectContaining({
      input: {
        resource: {
          _tag: "media-file",
          threadId: threadRef.threadId,
          path: "/tmp/report.html",
        },
      },
    }),
  );
});
it("can open a draft workspace file externally before a thread exists", async () => {
  await render(true);
  await actions.activate("report.html", "external");
  expect(state.createUrl).toHaveBeenCalledWith(
    expect.objectContaining({
      input: {
        resource: {
          _tag: "draft-workspace-file",
          cwd: "/work",
          path: "/work/report.html",
        },
      },
    }),
  );
});
it("reserves a web tab during the gesture and closes it when URL creation fails", async () => {
  const tab = { opener: {}, location: { replace: vi.fn() }, close: vi.fn() };
  const open = vi.fn(() => tab);
  vi.stubGlobal("window", { open });
  state.createUrl.mockResolvedValue(
    AsyncResult.failure(Cause.fail(new Error("File no longer exists"))),
  );
  await render();
  const result = actions.activate("report.html", "external");
  expect(open).toHaveBeenCalledWith("about:blank", "_blank");
  await result;
  expect(tab.opener).toBeNull();
  expect(tab.close).toHaveBeenCalled();
  expect(tab.location.replace).not.toHaveBeenCalled();
  expect(state.toast).toHaveBeenCalledWith(
    expect.objectContaining({ type: "error", description: "File no longer exists" }),
  );
});
it("does not read or open a file without filesystem permission", async () => {
  state.canRead = false;
  await render();
  await actions.activate("report.html", "external");
  expect(state.createUrl).not.toHaveBeenCalled();
  expect(state.openExternal).not.toHaveBeenCalled();
});

it("uses the owning environment origin for a remote HTML file", async () => {
  state.httpBaseUrl = "https://remote.example.test/t3/";
  await render();
  await actions.activate("report.html", "external");
  expect(state.openExternal).toHaveBeenCalledWith(
    "https://remote.example.test/api/assets/token/report.html",
  );
});
it("does not open a URL after file access is revoked during signing", async () => {
  let finish: (value: unknown) => void = () => {
    throw new Error("Signing not started");
  };
  state.createUrl.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await render();
  const pending = actions.activate("report.html", "external");
  state.canRead = false;
  finish(AsyncResult.success({ relativeUrl: "/api/assets/token/report.html" }));
  await pending;
  expect(state.openExternal).not.toHaveBeenCalled();
  expect(state.toast).toHaveBeenCalledWith(expect.objectContaining({ type: "error" }));
});
it("reports blocked popups without minting an asset URL", async () => {
  vi.stubGlobal("window", { open: vi.fn(() => null) });
  await render();
  await actions.activate("report.html", "external");
  expect(state.createUrl).not.toHaveBeenCalled();
  expect(state.toast).toHaveBeenCalledWith(
    expect.objectContaining({ description: expect.stringContaining("Allow pop-ups") }),
  );
});
it("closes a reserved tab when signing rejects", async () => {
  const tab = { opener: {}, closed: false, location: { replace: vi.fn() }, close: vi.fn() };
  vi.stubGlobal("window", { open: vi.fn(() => tab) });
  state.createUrl.mockRejectedValue(new Error("Disconnected"));
  await render();
  await actions.activate("report.html", "external");
  expect(tab.close).toHaveBeenCalledOnce();
  expect(tab.location.replace).not.toHaveBeenCalled();
});
it("does not navigate a tab the user closed while signing", async () => {
  const tab = { opener: {}, closed: true, location: { replace: vi.fn() }, close: vi.fn() };
  vi.stubGlobal("window", { open: vi.fn(() => tab) });
  await render();
  await actions.activate("report.html", "external");
  expect(tab.location.replace).not.toHaveBeenCalled();
});
it("rejects non-HTTP asset URLs", async () => {
  state.createUrl.mockResolvedValue(AsyncResult.success({ relativeUrl: "javascript:alert(1)" }));
  await render();
  await actions.activate("report.html", "external");
  expect(state.openExternal).not.toHaveBeenCalled();
  expect(state.toast).toHaveBeenCalledWith(expect.objectContaining({ type: "error" }));
});
