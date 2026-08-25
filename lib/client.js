window.__ModuleLoader__.load({ id: 'dsh-pilot', factory: (require) => { var module = { exports: {} }; var exports = module.exports;
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name2 in all)
    __defProp(target, name2, { get: all[name2], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/client/index.jsx
var index_exports = {};
__export(index_exports, {
  apply: () => apply,
  inject: () => inject,
  name: () => name
});
module.exports = __toCommonJS(index_exports);
var import_react = __toESM(require("react"), 1);
var name = "dsh-pilot";
var inject = ["slots"];
var POLL_MS = 2e3;
var store = { open: false, listeners: /* @__PURE__ */ new Set() };
function setOpen(open) {
  store.open = open;
  for (const listener of store.listeners) listener();
}
function useOpen() {
  const [open, setOpenState] = (0, import_react.useState)(store.open);
  (0, import_react.useEffect)(() => {
    const listener = () => setOpenState(store.open);
    store.listeners.add(listener);
    return () => {
      store.listeners.delete(listener);
    };
  }, []);
  return [open, setOpen];
}
var panelStyle = {
  position: "fixed",
  top: "4.5rem",
  left: "20rem",
  zIndex: 1200,
  width: 340,
  borderRadius: 12,
  overflow: "hidden",
  background: "rgba(24, 26, 32, 0.96)",
  border: "1px solid rgba(255, 255, 255, 0.14)",
  boxShadow: "0 12px 40px rgba(0, 0, 0, 0.45)",
  fontFamily: "system-ui, sans-serif",
  color: "#e8eaf0",
  userSelect: "none"
};
var barStyle = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "8px 10px",
  cursor: "move",
  background: "rgba(255, 255, 255, 0.06)"
};
var btnStyle = {
  background: "rgba(255, 255, 255, 0.12)",
  color: "#e8eaf0",
  border: "none",
  borderRadius: 6,
  padding: "4px 10px",
  cursor: "pointer",
  fontSize: 12
};
var shotWrapStyle = {
  height: 220,
  background: "#101218",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  overflow: "hidden"
};
var shotStyle = { maxWidth: "100%", maxHeight: "100%", objectFit: "contain" };
async function post(path, body) {
  const res = await fetch(`/dsh-pilot/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {})
  });
  if (!res.ok) throw new Error(`pilot: http ${res.status}`);
  return res.json();
}
function PilotPanel() {
  const [open] = useOpen();
  const [state, setState] = (0, import_react.useState)(null);
  const [tick, setTick] = (0, import_react.useState)(0);
  const [busy, setBusy] = (0, import_react.useState)(false);
  const [navUrl, setNavUrl] = (0, import_react.useState)("");
  const [pos, setPos] = (0, import_react.useState)({ x: null, y: null });
  const drag = (0, import_react.useRef)(null);
  (0, import_react.useEffect)(() => {
    if (!open) return;
    let alive = true;
    const poll = async () => {
      try {
        const res = await fetch("/dsh-pilot/state", { cache: "no-store" });
        if (res.ok && alive) {
          setState(await res.json());
          setTick((t) => t + 1);
        }
      } catch {
      }
    };
    poll();
    const timer = setInterval(poll, POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [open]);
  if (!open) return null;
  const run = async (action, body) => {
    setBusy(true);
    try {
      const next = await post(action, body);
      setState(next);
      if (action === "navigate") setNavUrl("");
      setTick((t) => t + 1);
    } catch (error) {
      console.error("[dsh-pilot]", error);
    } finally {
      setBusy(false);
    }
  };
  const onPointerDown = (event) => {
    drag.current = { startX: event.clientX, startY: event.clientY, baseX: pos.x ?? 0, baseY: pos.y ?? 0 };
    const move = (moveEvent) => {
      const d = drag.current;
      if (d === null) return;
      setPos({ x: d.baseX + moveEvent.clientX - d.startX, y: d.baseY + moveEvent.clientY - d.startY });
    };
    const up = () => {
      drag.current = null;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const style = pos.x === null ? panelStyle : { ...panelStyle, left: pos.x, top: pos.y };
  return import_react.default.createElement(
    "div",
    { style, onPointerDown },
    import_react.default.createElement(
      "div",
      { style: barStyle },
      import_react.default.createElement("span", { style: { fontSize: 16, lineHeight: 1, whiteSpace: "nowrap" }, title: "\u6D4F\u89C8\u5668\u9A7E\u9A76\u8231" }, "\u{1F6E9}\uFE0F"),
      import_react.default.createElement("span", { style: { flex: 1 } }),
      state?.sessionOptions?.length > 1 ? import_react.default.createElement("select", {
        style: { width: 160, minWidth: 0, background: "rgba(255,255,255,0.08)", color: "#e8eaf0", border: "1px solid rgba(255,255,255,0.15)", borderRadius: 5, padding: "3px 5px", fontSize: 11 },
        value: state.selectedSession ?? "latest",
        disabled: busy,
        title: "\u9009\u62E9\u8981\u5728\u9A7E\u9A76\u8231\u4E2D\u67E5\u770B\u7684\u4F1A\u8BDD\uFF1B\u201C\u6700\u8FD1\u6D3B\u8DC3\u201D\u4F1A\u81EA\u52A8\u8DDF\u968F agent",
        onPointerDown: (event) => event.stopPropagation(),
        onChange: (event) => run("select-session", { session: event.target.value })
      }, [
        import_react.default.createElement("option", { key: "latest", value: "latest" }, "\u6700\u8FD1\u6D3B\u8DC3"),
        ...state.sessionOptions.map((option) => import_react.default.createElement(
          "option",
          { key: option.id, value: option.id },
          `${option.primary ? "\u25CF " : ""}${option.id}${option.title ? ` \u2014 ${option.title.slice(0, 40)}` : ""}`
        ))
      ]) : null,
      import_react.default.createElement("span", { style: { fontSize: 11, opacity: 0.7 } }, state?.status ?? "\u2026"),
      import_react.default.createElement("button", { style: btnStyle, onClick: () => setOpen(false), title: "\u6536\u8D77" }, "\xD7")
    ),
    import_react.default.createElement(
      "div",
      { style: shotWrapStyle },
      state?.status === "ready" && tick > 0 ? import_react.default.createElement("img", { src: `/dsh-pilot/shot.png?t=${tick}`, style: shotStyle, draggable: false }) : import_react.default.createElement(
        "span",
        { style: { fontSize: 12, opacity: 0.55 } },
        state?.status === "starting" ? "\u6D4F\u89C8\u5668\u542F\u52A8\u4E2D\u2026" : "\u672A\u542F\u52A8\uFF0C\u70B9\u4E0B\u65B9\u300C\u542F\u52A8\u6D4F\u89C8\u5668\u300D"
      )
    ),
    import_react.default.createElement(
      "div",
      { style: { padding: "8px 10px", display: "flex", gap: 6, flexWrap: "wrap" } },
      import_react.default.createElement("button", { style: btnStyle, disabled: busy, title: "\u542F\u52A8\u6D4F\u89C8\u5668", onClick: () => run("start") }, "\u25B6 \u542F\u52A8"),
      import_react.default.createElement("button", { style: btnStyle, disabled: busy, title: "\u5173\u95ED\u6D4F\u89C8\u5668", onClick: () => run("stop") }, "\u25A0 \u5173\u95ED"),
      import_react.default.createElement("input", {
        style: { flex: 1, minWidth: 120, background: "rgba(255,255,255,0.08)", color: "#e8eaf0", border: "1px solid rgba(255,255,255,0.15)", borderRadius: 6, padding: "4px 8px", fontSize: 12 },
        placeholder: "https://\u2026",
        title: "\u5730\u5740\u680F",
        value: navUrl,
        onChange: (event) => setNavUrl(event.target.value),
        onKeyDown: (event) => {
          if (event.key === "Enter") run("navigate", { url: navUrl });
        }
      }),
      import_react.default.createElement("button", { style: btnStyle, disabled: busy || !/^https?:\/\//.test(navUrl), title: "\u524D\u5F80", onClick: () => run("navigate", { url: navUrl }) }, "\u524D\u5F80")
    ),
    state?.title || state?.url ? import_react.default.createElement(
      "div",
      { style: { padding: "0 10px 6px", fontSize: 11, opacity: 0.75, wordBreak: "break-all" } },
      `${state.title || ""} ${state.url || ""}`
    ) : null,
    state?.log?.length ? import_react.default.createElement(
      "div",
      { style: { padding: "0 10px 10px", fontSize: 10, opacity: 0.6, maxHeight: 72, overflow: "hidden" } },
      state.log.slice(-4).map((entry) => `${new Date(entry.t).toLocaleTimeString()} ${entry.msg}`).join("\n")
    ) : null
  );
}
function PilotButton() {
  const [open, openSet] = useOpen();
  return import_react.default.createElement("button", {
    title: "\u6D4F\u89C8\u5668\u9A7E\u9A76\u8231",
    style: { background: "none", border: "none", cursor: "pointer", fontSize: 15, padding: 4 },
    onClick: () => openSet(!open)
  }, open ? "\u{1F6E9}\uFE0F" : "\u2708\uFE0F");
}
function apply(ctx) {
  const slots = ctx.slots;
  if (slots === void 0) return;
  slots.inject("sidebar.footer.action", () => slots.register(
    { name: "sidebar.footer.action", id: "dsh-pilot", order: 900, label: "\u6D4F\u89C8\u5668\u9A7E\u9A76\u8231" },
    () => import_react.default.createElement(PilotButton)
  ));
  slots.inject("shell.overlay", () => slots.register(
    { name: "shell.overlay", id: "dsh-pilot-panel", order: 200, label: "\u6D4F\u89C8\u5668\u9A7E\u9A76\u8231" },
    () => import_react.default.createElement(PilotPanel)
  ));
}
return module.exports; } });
//# sourceMappingURL=client.js.map
