import { useEffect, useMemo, useState } from "react";
import type {
  ZModelEntry,
  ZProviderAddResult,
  ZProviderConfig,
  ZProviderEntry,
} from "../../shared/types";
import { api } from "../api";
import { Panel } from "./ui/panel";
import {
  Box,
  ChevronDown,
  ChevronRight,
  Eye,
  EyeOff,
  Pencil,
  Plug,
  Plus,
  RefreshCw,
  Sparkles,
  X,
} from "lucide-react";

/**
 * 危险操作的两步确认按钮:Tauri 的 WKWebView 里 window.confirm 不弹窗、静默返回 false,
 * 所以第一次点击只进入"待确认"态,再点一次才真正执行(3 秒不点自动复原)
 */
function DangerousButton({
  label,
  confirmLabel,
  disabled,
  onConfirm,
}: {
  label: string;
  confirmLabel: string;
  disabled?: boolean;
  onConfirm: () => void;
}) {
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    if (!armed) return;
    const t = window.setTimeout(() => setArmed(false), 3000);
    return () => window.clearTimeout(t);
  }, [armed]);

  return (
    <button
      className={"btn danger" + (armed ? " armed" : "")}
      disabled={disabled}
      onBlur={() => setArmed(false)}
      onClick={() => {
        if (!armed) {
          setArmed(true);
          return;
        }
        setArmed(false);
        onConfirm();
      }}
    >
      {armed ? confirmLabel : label}
    </button>
  );
}

/** 统一的变更执行器:调接口、拿写后的最新配置刷新列表、收集错误 */
type Act = (action: () => Promise<ZProviderConfig>) => Promise<boolean>;

/** limit 草稿解析:空串=null(删除字段),非负整数=数值,其余=undefined(非法) */
function toLimitValue(s: string): number | null | undefined {
  const t = s.trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}

function limitToDraft(v: number | null): string {
  return v === null ? "" : String(v);
}

/** 上限的紧凑徽标显示:131072→128K,200000→200K,1048576→1M */
function fmtLimit(n: number): string {
  if (n >= 1048576 && n % 1048576 === 0) return `${n / 1048576}M`;
  if (n % 1024 === 0) return `${n / 1024}K`;
  if (n % 1000 === 0) return `${n / 1000}K`;
  return String(n);
}

// 常用档位预置;数值与主流模型的实际配置对齐(K 按 1024,M 按 1048576)
const CONTEXT_PRESETS = [
  { label: "32K", value: 32768 },
  { label: "64K", value: 65536 },
  { label: "128K", value: 131072 },
  { label: "200K", value: 200000 },
  { label: "256K", value: 262144 },
  { label: "512K", value: 524288 },
  { label: "1M", value: 1048576 },
];

const OUTPUT_PRESETS = [
  { label: "4K", value: 4096 },
  { label: "8K", value: 8192 },
  { label: "16K", value: 16384 },
  { label: "32K", value: 32768 },
  { label: "64K", value: 65536 },
  { label: "128K", value: 131072 },
];

/**
 * 上限输入 = 预设下拉 + 自定义数字框。值是草稿字符串(与 toLimitValue 配合):
 * 匹配预设时隐藏数字框;resetKey 变化(外部刷新/保存回填)时退出自定义态
 */
function LimitInput({
  presets,
  value,
  resetKey,
  onChange,
}: {
  presets: { label: string; value: number }[];
  value: string;
  resetKey?: string;
  onChange: (v: string) => void;
}) {
  const [customMode, setCustomMode] = useState(false);

  useEffect(() => {
    setCustomMode(false);
  }, [resetKey]);

  const matched = presets.find((p) => String(p.value) === value);
  const selValue = customMode || (value !== "" && !matched) ? "custom" : value;

  return (
    <span className="limit-input">
      <select
        value={selValue}
        onChange={(e) => {
          const v = e.target.value;
          if (v === "custom") {
            setCustomMode(true);
          } else {
            setCustomMode(false);
            onChange(v);
          }
        }}
      >
        <option value="">未设置</option>
        {presets.map((p) => (
          <option key={p.value} value={p.value}>
            {p.label}
          </option>
        ))}
        <option value="custom">自定义…</option>
      </select>
      {selValue === "custom" && (
        <input
          className="price-input"
          type="number"
          min="0"
          value={value}
          placeholder="token 数"
          autoFocus
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </span>
  );
}

/** 单个模型条目:默认只读徽标视图,点铅笔进入上限/模态编辑 */
function ModelItem({
  providerId,
  m,
  act,
}: {
  providerId: string;
  m: ZModelEntry;
  act: Act;
}) {
  const [editing, setEditing] = useState(false);
  const [contextDraft, setContextDraft] = useState(limitToDraft(m.contextLimit));
  const [outputDraft, setOutputDraft] = useState(limitToDraft(m.outputLimit));
  const [image, setImage] = useState(m.inputImage);
  const [video, setVideo] = useState(m.inputVideo);

  useEffect(() => {
    setContextDraft(limitToDraft(m.contextLimit));
    setOutputDraft(limitToDraft(m.outputLimit));
    setImage(m.inputImage);
    setVideo(m.inputVideo);
  }, [m.contextLimit, m.outputLimit, m.inputImage, m.inputVideo]);

  const ctx = toLimitValue(contextDraft);
  const out = toLimitValue(outputDraft);
  const dirty =
    ctx !== undefined &&
    out !== undefined &&
    (ctx !== m.contextLimit ||
      out !== m.outputLimit ||
      image !== m.inputImage ||
      video !== m.inputVideo);

  const save = async () => {
    if (!(await act(() => api.setProviderModelLimits(providerId, m.name, ctx!, out!)))) return;
    if (image !== m.inputImage || video !== m.inputVideo) {
      if (
        !(await act(() =>
          api.setProviderModelInputModalities(providerId, m.name, image, video),
        ))
      )
        return;
    }
    setEditing(false);
  };

  if (!editing) {
    return (
      <div className="model-item">
        <span className="model-name">{m.name}</span>
        {(m.contextLimit !== null || m.outputLimit !== null) && (
          <span className="badge plain" title="上下文 / 输出上限">
            {m.contextLimit !== null ? fmtLimit(m.contextLimit) : "—"}
            {" / "}
            {m.outputLimit !== null ? fmtLimit(m.outputLimit) : "—"}
          </span>
        )}
        {m.inputImage && <span className="badge info">图像</span>}
        {m.inputVideo && <span className="badge info">视频</span>}
        <span className="spacer" />
        <button className="btn" title="编辑上限与输入模态" onClick={() => setEditing(true)}>
          <Pencil size={12} />
        </button>
        <DangerousButton
          label="删除"
          confirmLabel="确认?"
          onConfirm={() => act(() => api.removeProviderModel(providerId, m.name))}
        />
      </div>
    );
  }

  return (
    <div className="model-item editing">
      <span className="model-name">{m.name}</span>
      <label className="mini-field">
        <span>上下文</span>
        <LimitInput
          presets={CONTEXT_PRESETS}
          value={contextDraft}
          resetKey={`ctx:${m.contextLimit}`}
          onChange={setContextDraft}
        />
      </label>
      <label className="mini-field">
        <span>输出</span>
        <LimitInput
          presets={OUTPUT_PRESETS}
          value={outputDraft}
          resetKey={`out:${m.outputLimit}`}
          onChange={setOutputDraft}
        />
      </label>
      <label className="mini-check" title="modalities.input 含 image">
        <input type="checkbox" checked={image} onChange={(e) => setImage(e.target.checked)} />
        图像
      </label>
      <label className="mini-check" title="modalities.input 含 video">
        <input type="checkbox" checked={video} onChange={(e) => setVideo(e.target.checked)} />
        视频
      </label>
      <span className="spacer" />
      <button
        className="btn primary"
        disabled={!dirty}
        title={dirty ? "保存上限与模态" : "修改后再保存"}
        onClick={() => void save()}
      >
        保存
      </button>
      <button className="btn" onClick={() => setEditing(false)}>
        取消
      </button>
    </div>
  );
}

/** 新增供应商表单(详情区展示,成功后选中并展开新供应商) */
const KIND_OPTIONS = [
  { value: "anthropic", label: "Anthropic 协议" },
  { value: "openai-compatible", label: "OpenAI 兼容协议" },
];

// zcode 内置的订阅制条目(BigModel/Z.ai 的 Coding Plan 系列)由 ZCode 账号体系管理,
// 这里无法配置,面板直接不展示
function isCodingPlan(p: ZProviderEntry): boolean {
  return p.builtin && p.name.toLowerCase().includes("coding plan");
}

function NewProviderForm({
  onAdded,
  onCancel,
}: {
  onAdded: (r: ZProviderAddResult) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState(KIND_OPTIONS[0].value);
  const [baseUrl, setBaseUrl] = useState("");
  const [keyDraft, setKeyDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const add = async () => {
    setBusy(true);
    setError(null);
    try {
      onAdded(
        await api.addProvider(
          name.trim(),
          kind,
          baseUrl.trim() || null,
          keyDraft.trim() || null,
        ),
      );
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  };

  return (
    <div className="detail-section">
      <div className="kv-label">
        新增供应商
        <span className="muted-note">Base URL 与 API Key 可留空,保存后再补;模型需另行添加或从接口导入</span>
      </div>
      <div className="form-row">
        <label className="form-field">
          <span>名称</span>
          <input
            className="text-input"
            value={name}
            placeholder="如 我的中转站"
            autoFocus
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label className="form-field">
          <span>类型</span>
          <select className="text-input" value={kind} onChange={(e) => setKind(e.target.value)}>
            {KIND_OPTIONS.map((k) => (
              <option key={k.value} value={k.value}>
                {k.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="form-row">
        <label className="form-field grow">
          <span>Base URL</span>
          <input
            className="text-input"
            value={baseUrl}
            placeholder="如 https://api.example.com/v1"
            onChange={(e) => setBaseUrl(e.target.value)}
          />
        </label>
      </div>
      <div className="form-row">
        <label className="form-field grow">
          <span>API Key</span>
          <input
            className="text-input"
            type="password"
            value={keyDraft}
            placeholder="可留空"
            onChange={(e) => setKeyDraft(e.target.value)}
          />
        </label>
      </div>
      <div className="form-row">
        <button
          className="btn primary"
          disabled={busy || name.trim() === ""}
          title={name.trim() ? "写入 zcode 配置文件" : "先填写名称"}
          onClick={() => void add()}
        >
          {busy ? "添加中…" : "添加供应商"}
        </button>
        <button className="btn" disabled={busy} onClick={onCancel}>
          取消
        </button>
      </div>
      {error && <div className="error-note">{error}</div>}
    </div>
  );
}

/**
 * 选中供应商的详情区:连接配置、模型列表、远程拉取与删除;
 * 密钥只在输入框里临时存在,提交即清空
 */
function ProviderDetail({
  p,
  onChanged,
}: {
  p: ZProviderEntry;
  onChanged: (c: ZProviderConfig) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [baseUrlDraft, setBaseUrlDraft] = useState(p.baseURL ?? "");
  const [keyDraft, setKeyDraft] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [addingModel, setAddingModel] = useState(false);
  const [newName, setNewName] = useState("");
  const [newContext, setNewContext] = useState("");
  const [newOutput, setNewOutput] = useState("");
  const [newImage, setNewImage] = useState(false);
  const [newVideo, setNewVideo] = useState(false);
  // 远程模型列表(从接口拉取)与勾选状态
  const [remoteModels, setRemoteModels] = useState<string[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [fetching, setFetching] = useState(false);

  const configured = useMemo(() => new Set(p.models.map((m) => m.name)), [p.models]);

  // 列表刷新(含本行保存成功)后让草稿跟上已保存的值
  useEffect(() => {
    setBaseUrlDraft(p.baseURL ?? "");
  }, [p.baseURL]);

  const run: Act = async (action) => {
    setBusy(true);
    setError(null);
    try {
      onChanged(await action());
      return true;
    } catch (e) {
      setError(String(e));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const pullRemote = async () => {
    setFetching(true);
    setError(null);
    try {
      const list = await api.fetchProviderModels(p.id);
      setRemoteModels(list);
      // 默认只勾选尚未配置的
      setPicked(new Set(list.filter((n) => !configured.has(n))));
    } catch (e) {
      setError(String(e));
    } finally {
      setFetching(false);
    }
  };

  const importPicked = async () => {
    if (await run(() => api.addProviderModels(p.id, [...picked]))) setPicked(new Set());
  };

  const canAddModel =
    newName.trim() !== "" &&
    toLimitValue(newContext) !== undefined &&
    toLimitValue(newOutput) !== undefined;

  const addModel = async () => {
    if (
      await run(() =>
        api.addProviderModel(
          p.id,
          newName.trim(),
          toLimitValue(newContext) ?? null,
          toLimitValue(newOutput) ?? null,
          newImage,
          newVideo,
        ),
      )
    ) {
      setNewName("");
      setNewContext("");
      setNewOutput("");
      setNewImage(false);
      setNewVideo(false);
      setAddingModel(false);
    }
  };

  return (
    <>
      <div className="pv-detail-head">
        {p.builtin ? <Sparkles size={16} /> : <Box size={16} />}
        <span className="pv-detail-name">{p.name}</span>
        <span className={"badge " + (p.builtin ? "info" : "plain")}>
          {p.builtin ? "内置" : "自定义"}
        </span>
        <span className={"badge " + (p.enabled ? "ok" : "warn")}>
          {p.enabled ? "已启用" : "已停用"}
        </span>
        {p.systemDisabledReason && (
          <span className="muted-note">系统禁用:{p.systemDisabledReason}</span>
        )}
        <span className="spacer" />
        {/* 内置供应商只管理 API Key 这一种连接方式;自定义按协议展示 */}
        {p.builtin ? (
          <span className="muted-note">连接方式 API Key</span>
        ) : (
          p.kind && <span className="muted-note">连接方式 {p.kind}</span>
        )}
        <button
          role="switch"
          aria-checked={p.enabled}
          className={"switch" + (p.enabled ? " on" : "")}
          disabled={busy}
          title={p.enabled ? "点击禁用该供应商" : "点击启用该供应商"}
          onClick={() => run(() => api.setProviderEnabled(p.id, !p.enabled))}
        />
        {!p.builtin && (
          <DangerousButton
            label="删除"
            confirmLabel="确认删除?"
            disabled={busy}
            onConfirm={() => void run(() => api.removeProvider(p.id))}
          />
        )}
      </div>

      {p.builtin && (
        <div className="muted-note">
          此处仅管理内置供应商的 API Key,其他连接方式(如账号登录)请在 ZCode 中操作
        </div>
      )}

      <div className="detail-section">
        <div className="kv-label">Base URL</div>
        {p.builtin ? (
          <div className="pv-ro">{p.baseURL ?? "未设置"}</div>
        ) : (
          <div className="form-row">
            <label className="form-field grow">
              <input
                className="text-input"
                value={baseUrlDraft}
                placeholder={p.baseURL ?? "未设置"}
                onChange={(e) => setBaseUrlDraft(e.target.value)}
              />
            </label>
            <button
              className="btn"
              disabled={busy || baseUrlDraft === (p.baseURL ?? "")}
              onClick={() =>
                run(() => api.setProviderBaseUrl(p.id, baseUrlDraft.trim() ? baseUrlDraft : null))
              }
            >
              保存
            </button>
          </div>
        )}
      </div>

      <div className="detail-section">
        <div className="kv-label">
          API Key
          <span className="muted-note">
            {p.hasApiKey
              ? p.apiKeyHint
                ? `已设置 ••••${p.apiKeyHint}`
                : "已设置"
              : "未设置"}
          </span>
        </div>
        <div className="form-row">
          <label className="form-field grow">
            <input
              className="text-input"
              type={showKey ? "text" : "password"}
              value={keyDraft}
              placeholder="输入新 Key(不会显示已设置的)"
              onChange={(e) => setKeyDraft(e.target.value)}
            />
          </label>
          <button
            className="btn"
            title={showKey ? "隐藏输入内容" : "显示输入内容"}
            onClick={() => setShowKey((v) => !v)}
          >
            {showKey ? <EyeOff size={12} /> : <Eye size={12} />}
          </button>
          <button
            className="btn"
            disabled={busy || !keyDraft.trim()}
            onClick={async () => {
              if (await run(() => api.setProviderApiKey(p.id, keyDraft))) setKeyDraft("");
            }}
          >
            更新
          </button>
          {p.hasApiKey && (
            <DangerousButton
              label="清除"
              confirmLabel="确认清除 Key?"
              disabled={busy}
              onConfirm={() => {
                void run(() => api.setProviderApiKey(p.id, null)).then((ok) => {
                  if (ok) setKeyDraft("");
                });
              }}
            />
          )}
        </div>
      </div>

      <div className="detail-section">
        <div className="pv-section-head">
          <span className="kv-label">模型列表</span>
          <span className="muted-note">
            {p.models.length > 0 ? `${p.models.length} 个` : "暂无"}
          </span>
          <span className="spacer" />
          <button
            className="btn"
            disabled={busy || fetching || !p.baseURL}
            title={p.baseURL ? "从该供应商的接口拉取可用模型列表" : "需先设置并保存 Base URL"}
            onClick={pullRemote}
          >
            <Plug size={12} />
            {fetching ? "拉取中…" : "从接口拉取"}
          </button>
        </div>
        {!p.hasApiKey && p.baseURL && (
          <div className="muted-note">未设置 API Key,将以匿名请求尝试</div>
        )}

        <div className="model-list">
          {p.models.map((m) => (
            <ModelItem key={m.name} providerId={p.id} m={m} act={run} />
          ))}
          {p.models.length === 0 && !addingModel && (
            <div className="muted-note model-empty">暂无模型,可点击下方「添加模型」</div>
          )}
        </div>

        {addingModel ? (
          <div className="model-item editing">
            <label className="mini-field grow">
              <span>模型 ID</span>
              <input
                className="text-input"
                value={newName}
                placeholder="如 glm-5.3"
                autoFocus
                onChange={(e) => setNewName(e.target.value)}
              />
            </label>
            <label className="mini-field">
              <span>上下文</span>
              <LimitInput presets={CONTEXT_PRESETS} value={newContext} onChange={setNewContext} />
            </label>
            <label className="mini-field">
              <span>输出</span>
              <LimitInput presets={OUTPUT_PRESETS} value={newOutput} onChange={setNewOutput} />
            </label>
            <label className="mini-check" title="modalities.input 含 image">
              <input
                type="checkbox"
                checked={newImage}
                onChange={(e) => setNewImage(e.target.checked)}
              />
              图像
            </label>
            <label className="mini-check" title="modalities.input 含 video">
              <input
                type="checkbox"
                checked={newVideo}
                onChange={(e) => setNewVideo(e.target.checked)}
              />
              视频
            </label>
            <span className="spacer" />
            <button className="btn primary" disabled={!canAddModel || busy} onClick={addModel}>
              添加
            </button>
            <button className="btn" onClick={() => setAddingModel(false)}>
              <X size={12} />
            </button>
          </div>
        ) : (
          <button className="btn" onClick={() => setAddingModel(true)}>
            <Plus size={12} />
            添加模型
          </button>
        )}

        {remoteModels !== null && (
          <div className="pick-block">
            <div className="pick-actions">
              <span className="muted">
                接口返回 {remoteModels.length} 个模型,已选 {picked.size} 个未配置项
              </span>
              <button
                className="btn"
                disabled={busy}
                onClick={() =>
                  setPicked(new Set(remoteModels.filter((n) => !configured.has(n))))
                }
              >
                全选未配置
              </button>
              <button
                className="btn primary"
                disabled={picked.size === 0 || busy}
                onClick={importPicked}
              >
                导入选中({picked.size})
              </button>
              <button className="btn" onClick={() => setRemoteModels(null)}>
                收起列表
              </button>
            </div>
            <div className="pick-box">
              {remoteModels.map((name) => {
                const isConfigured = configured.has(name);
                return (
                  <label key={name} className={"pick-item" + (isConfigured ? " configured" : "")}>
                    <input
                      type="checkbox"
                      disabled={isConfigured || busy}
                      checked={isConfigured || picked.has(name)}
                      onChange={(e) => {
                        const next = new Set(picked);
                        if (e.target.checked) next.add(name);
                        else next.delete(name);
                        setPicked(next);
                      }}
                    />
                    <span>{name}</span>
                    {isConfigured && <span className="badge info">已配置</span>}
                  </label>
                );
              })}
              {remoteModels.length === 0 && <span className="muted">接口没有返回任何模型</span>}
            </div>
          </div>
        )}
      </div>

      {error && <div className="error-note">{error}</div>}
    </>
  );
}

/**
 * zcode 供应商面板:左侧供应商列表(内置/自定义分组 + 添加入口),
 * 右侧为选中项的连接与模型配置。修改直接写入 zcode 配置文件(自动备份)。
 */
export function ProviderPanel() {
  const [config, setConfig] = useState<ZProviderConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // 添加模式:详情区显示新增表单
  const [adding, setAdding] = useState(false);

  const reload = async () => {
    setLoading(true);
    try {
      setConfig(await api.providerConfig());
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void reload();
  }, []);

  // 配置刷新后修正选中项:未选中、选中项被删除或被隐藏时,回退到可见列表第一项
  useEffect(() => {
    if (!config || adding) return;
    const visible = config.providers.filter((p) => !isCodingPlan(p));
    if (selectedId && visible.some((p) => p.id === selectedId)) return;
    setSelectedId(visible[0]?.id ?? null);
  }, [config, selectedId, adding]);

  const handleAdded = (r: ZProviderAddResult) => {
    setConfig(r.config);
    setError(null);
    setAdding(false);
    setSelectedId(r.newId);
  };

  const visible = config?.providers.filter((p) => !isCodingPlan(p)) ?? [];
  const selected = adding ? null : (visible.find((p) => p.id === selectedId) ?? null);

  const renderItem = (p: ZProviderEntry) => (
    <button
      key={p.id}
      className={"pv-item" + (selected?.id === p.id ? " active" : "")}
      title={p.id}
      onClick={() => {
        setAdding(false);
        setSelectedId(p.id);
      }}
    >
      {p.builtin ? <Sparkles size={13} /> : <Box size={13} />}
      <span className="pv-item-name">{p.name}</span>
      <span
        className={"pv-dot" + (p.enabled ? "" : " off")}
        title={p.enabled ? "已启用" : "已停用"}
      />
    </button>
  );

  return (
    <Panel
      title="供应商"
      sub={config ? `${visible.length} 个 · ${config.path}` : undefined}
      actions={
        <button
          className="btn"
          disabled={loading}
          title="重新读取配置文件(zcode CLI 等外部改动也一并生效)"
          onClick={() => void reload()}
        >
          <RefreshCw size={12} className={loading ? "spin" : undefined} />
          {loading ? "刷新中…" : "刷新"}
        </button>
      }
    >
      <p className="px-1 pb-3 text-[11px] leading-relaxed text-muted-foreground">
        修改直接写入 zcode 配置文件，每次写入前自动备份到同目录（config.json.bak-时间戳，保留最近 5
        份）；正在运行的 zcode 会话可能需重启才生效。
      </p>
      {error && <p className="px-1 pb-3 text-[11px] text-danger">读取配置失败:{error}</p>}

      <div className="pv-layout">
        <div className="pv-sidebar">
          <div className="pv-group-label">供应商 · {visible.length}</div>
          {visible.map(renderItem)}
          <button
            className={"pv-item pv-add" + (adding ? " active" : "")}
            onClick={() => setAdding(true)}
          >
            <Plus size={13} />
            添加供应商
          </button>
        </div>
        <div className="pv-detail">
          {adding ? (
            <NewProviderForm onAdded={handleAdded} onCancel={() => setAdding(false)} />
          ) : selected ? (
            <ProviderDetail key={selected.id} p={selected} onChanged={setConfig} />
          ) : (
            <div className="empty">
              {config ? "从左侧选择供应商,或点击「添加供应商」" : "加载中…"}
            </div>
          )}
        </div>
      </div>
    </Panel>
  );
}


