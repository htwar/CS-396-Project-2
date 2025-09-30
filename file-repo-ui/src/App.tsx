import { AlertTriangle, CheckCircle2, Download, File as FileIcon, Hash, Network, RefreshCcw, Settings, Shield, Timer, Trash2, Upload } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { CartesianGrid, Line, LineChart, Tooltip as RTooltip, ResponsiveContainer, XAxis, YAxis } from "recharts";
import {
  Button, Card, CardContent, CardHeader, CardTitle,
  Input, Label, Separator, Switch, Tabs, TabsContent, TabsList, TabsTrigger,
  Tooltip, TooltipContent, TooltipProvider, TooltipTrigger
} from "./ui-shim";

// -----------------------
// Helper types & utilities
// -----------------------

type ReqLog = {
  id: string;
  method: string;
  url: string;
  status: number | null;
  ok: boolean | null;
  durationMs: number | null;
  bytes?: number | null;
  when: string; // ISO
  note?: string;
};

function uuid() {
  if (typeof crypto !== "undefined" && (crypto as any).randomUUID) return (crypto as any).randomUUID();
  // Fallback
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
    const r = (Math.random() * 16) | 0,
      v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function ms(n?: number | null) {
  if (n == null) return "—";
  return `${n.toFixed(1)} ms`;
}

function nowIso() {
  return new Date().toISOString();
}

// -----------------------
// Default Settings
// -----------------------

const DEFAULT_BASE_URL = ""; // Traefik LB in your stack

function useLocalStorage<T>(key: string, initial: T) {
  const [value, setValue] = useState<T>(() => {
    try {
      const s = localStorage.getItem(key);
      return s ? (JSON.parse(s) as T) : initial;
    } catch {
      return initial;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {}
  }, [key, value]);
  return [value, setValue] as const;
}

// -----------------------
// Fetch wrapper with metrics
// -----------------------

async function timedFetch(input: RequestInfo, init?: RequestInit) {
  const start = performance.now();
  let resp: Response | null = null;
  try {
    resp = await fetch(input, init);
    const end = performance.now();
    (resp as any)._durationMs = end - start;
    return resp;
  } catch (e) {
    const end = performance.now();
    (e as any)._durationMs = end - start;
    throw e;
  }
}

// -----------------------
// Main App
// -----------------------

export default function App() {
  // Settings
  const [baseUrl, setBaseUrl] = useLocalStorage("ui.baseUrl", DEFAULT_BASE_URL);
  const [apiKey, setApiKey] = useLocalStorage("ui.apiKey", "");
  const [adminKey, setAdminKey] = useLocalStorage("ui.adminKey", "");
  const [autoIdem, setAutoIdem] = useLocalStorage("ui.autoIdem", true);

  // Logs
  const [logs, setLogs] = useState<ReqLog[]>([]);

  const pushLog = (partial: Partial<ReqLog> & { method: string; url: string }) => {
    setLogs((prev) => [
      {
        id: uuid(),
        status: null,
        ok: null,
        durationMs: null,
        when: nowIso(),
        ...partial,
      },
      ...prev,
    ].slice(0, 250));
  };

  const finalizeLog = (id: string, updates: Partial<ReqLog>) => {
    setLogs((prev) => prev.map((l) => (l.id === id ? { ...l, ...updates } : l)));
  };

  // Health & Metrics
  const [healthOk, setHealthOk] = useState<boolean | null>(null);
  const [healthMsg, setHealthMsg] = useState<string>("");
  const [metricsRaw, setMetricsRaw] = useState<string>("");
  const [metricsSeries, setMetricsSeries] = useState<{ t: string; value: number }[]>([]);

  // Upload state
  const [uploadDir, setUploadDir] = useState("projects/demo");
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [lastUploadId, setLastUploadId] = useState<string>("");
  const [lastUploadChecksum, setLastUploadChecksum] = useState<string>("");

  // Download by ID state
  const [dlId, setDlId] = useState("");
  const [dlVersion, setDlVersion] = useState<string>("");

  // New Version state
  const [putId, setPutId] = useState("");
  const [putFile, setPutFile] = useState<File | null>(null);

  // Delete state
  const [delId, setDelId] = useState("");

  const commonHeaders = useMemo(() => {
    const h: Record<string, string> = {};
    if (apiKey) h["X-Api-Key"] = apiKey;
    if (adminKey) h["Admin-Key"] = adminKey;
    return h;
  }, [apiKey, adminKey]);

  // -----------------------
  // Health & Metrics polling
  // -----------------------
  useEffect(() => {
    let canceled = false;

    async function poll() {
      // Health
      try {
        const id = uuid();
        pushLog({ id, method: "GET", url: `${baseUrl}/healthz` });
        const resp = await timedFetch(`${baseUrl}/healthz`);
        const txt = await resp.text();
        finalizeLog(id, { status: resp.status, ok: resp.ok, durationMs: (resp as any)._durationMs, bytes: txt.length });
        if (!canceled) {
          setHealthOk(resp.ok);
          setHealthMsg(txt || (resp.ok ? "OK" : `HTTP ${resp.status}`));
        }
      } catch (e: any) {
        finalizeLog("", {}); // no-op
        if (!canceled) {
          setHealthOk(false);
          setHealthMsg(e?.message || "Health check failed");
        }
      }

      // Metrics
      try {
        const id = uuid();
        pushLog({ id, method: "GET", url: `${baseUrl}/metrics` });
        const resp = await timedFetch(`${baseUrl}/metrics`);
        const txt = await resp.text();
        finalizeLog(id, { status: resp.status, ok: resp.ok, durationMs: (resp as any)._durationMs, bytes: txt.length });
        if (!canceled) {
          setMetricsRaw(txt);
          // Very light parse: try to find a request counter (common names)
          const lines = txt.split(/\n/);
          const pick = lines.find((l) => /(^|\s)(http_requests_total|uvicorn_requests_total)/.test(l) && !l.startsWith("#"));
          const value = pick ? Number(pick.split(" ").pop() || "0") : NaN;
          const point = { t: new Date().toLocaleTimeString(), value: isFinite(value) ? value : 0 };
          setMetricsSeries((prev) => [...prev.slice(-59), point]);
        }
      } catch (e) {
        // ignore
      }
    }

    // initial + interval
    poll();
    const id = setInterval(poll, 5000);
    return () => {
      canceled = true;
      clearInterval(id);
    };
  }, [baseUrl, commonHeaders]);

  // -----------------------
  // Handlers
  // -----------------------

  async function handleUpload() {
    if (!uploadFile) return alert("Choose a file to upload");
    const form = new FormData();
    form.append("file", uploadFile);
  
    const idem = autoIdem ? `u-${uuid()}` : undefined;
    const headers: Record<string, string> = { ...commonHeaders };
    if (idem) headers["Idempotency-Key"] = idem;
  
    const url = `${baseUrl}/v1/files?dir=${encodeURIComponent(uploadDir)}`;
    const id = uuid();
    pushLog({ id, method: "POST", url, note: idem ? `Idempotency-Key=${idem}` : undefined });
  
    try {
      const resp = await timedFetch(url, { method: "POST", body: form, headers });
  
      // Read raw text THEN try JSON, so we always have something readable.
      const raw = await resp.text();
      let data: any = null;
      try { data = raw ? JSON.parse(raw) : null; } catch { /* not JSON */ }
  
      finalizeLog(id, {
        status: resp.status,
        ok: resp.ok,
        durationMs: (resp as any)._durationMs,
        bytes: raw.length
      });
  
      if (!resp.ok) {
        const msg =
          (data?.detail && (typeof data.detail === "string" ? data.detail : data.detail.msg || JSON.stringify(data.detail))) ||
          data?.message ||
          raw ||
          `Upload failed (HTTP ${resp.status})`;
        throw new Error(msg);
      }
  
      const fileId = data?.file_id ?? data?.id ?? "";
      const checksum = data?.checksum ?? data?.sha256 ?? "";
      setLastUploadId(fileId);
      setLastUploadChecksum(checksum);
      alert(`Uploaded! id=${fileId}${checksum ? `\nsha256=${checksum}` : ""}`);
    } catch (e: any) {
      alert(e?.message || "Upload failed (see Request Log for details)");
    }
  }

  async function handleDownloadById() {
    if (!dlId) return alert("Enter a file id");
    const q = dlVersion ? `?version=${encodeURIComponent(dlVersion)}` : "";
    const url = `${baseUrl}/v1/files/${encodeURIComponent(dlId)}${q}`;
    const id = uuid();
    pushLog({ id, method: "GET", url });
    try {
      const resp = await timedFetch(url, { headers: commonHeaders });
      const blob = await resp.blob();
      finalizeLog(id, { status: resp.status, ok: resp.ok, durationMs: (resp as any)._durationMs, bytes: blob.size });
      if (!resp.ok) throw new Error(`Download failed (HTTP ${resp.status})`);
      const a = document.createElement("a");
      const objectUrl = URL.createObjectURL(blob);
      a.href = objectUrl;
      // Try to infer filename from headers
      const cd = resp.headers.get("Content-Disposition");
      const m = cd && /filename="?([^";]+)"?/i.exec(cd);
      a.download = (m && m[1]) || `${dlId}${dlVersion ? `-v${dlVersion}` : ""}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(objectUrl);
    } catch (e: any) {
      alert(e.message || "Download failed");
    }
  }


  async function handlePutVersion() {
    if (!putId || !putFile) return alert("Enter id and choose file");
    const form = new FormData();
    form.append("file", putFile);
  
    const idem = autoIdem ? `u-${uuid()}` : undefined;
    const headers: Record<string, string> = { ...commonHeaders };
    if (idem) headers["Idempotency-Key"] = idem;
  
    const url = `${baseUrl}/v1/files/${encodeURIComponent(putId)}`;
    const id = uuid();
    pushLog({ id, method: "PUT", url, note: idem ? `Idempotency-Key=${idem}` : undefined });
  
    try {
      const resp = await timedFetch(url, { method: "PUT", body: form, headers });
      const raw = await resp.text();
      let data: any = null;
      try { data = raw ? JSON.parse(raw) : null; } catch {}
  
      finalizeLog(id, {
        status: resp.status,
        ok: resp.ok,
        durationMs: (resp as any)._durationMs,
        bytes: raw.length
      });
  
      if (!resp.ok) {
        const msg =
          (data?.detail && (typeof data.detail === "string" ? data.detail : data.detail.msg || JSON.stringify(data.detail))) ||
          data?.message ||
          raw ||
          `Version upload failed (HTTP ${resp.status})`;
        throw new Error(msg);
      }
  
      alert(`New version stored for id=${putId}`);
    } catch (e: any) {
      alert(e?.message || "Version upload failed (see Request Log for details)");
    }
  }

  async function handleDeleteId() {
    if (!delId) return alert("Enter a file id");
    if (!confirm("Delete this file and all its versions?")) return;
    const url = `${baseUrl}/v1/files/${encodeURIComponent(delId)}`;
    const id = uuid();
    pushLog({ id, method: "DELETE", url });
    try {
      const resp = await timedFetch(url, { method: "DELETE", headers: commonHeaders });
      const txt = await resp.text();
      finalizeLog(id, { status: resp.status, ok: resp.ok, durationMs: (resp as any)._durationMs, bytes: txt.length });
      if (!resp.ok) throw new Error(`Delete failed (HTTP ${resp.status})`);
      alert("Deleted");
    } catch (e: any) {
      alert(e.message || "Delete failed");
    }
  }

  // -----------------------
  // UI
  // -----------------------

  return (
    <TooltipProvider>
      <div className="min-h-screen w-full bg-gradient-to-b from-slate-50 to-white text-slate-900 p-4 md:p-8">
        <div className="max-w-7xl mx-auto space-y-6">
          <header className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
            <div>
              <h1 className="text-3xl font-bold tracking-tight">File Repository Console</h1>
              <p className="text-sm text-slate-600">Upload, version, retrieve, and delete files. Monitor health and latency to keep all requirements satisfied.</p>
            </div>
            <SettingsPanel
              baseUrl={baseUrl}
              setBaseUrl={setBaseUrl}
              apiKey={apiKey}
              setApiKey={setApiKey}
              adminKey={adminKey}
              setAdminKey={setAdminKey}
              autoIdem={autoIdem}
              setAutoIdem={setAutoIdem}
            />
          </header>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <Card className="lg:col-span-2">
              <CardHeader>
                <CardTitle className="flex items-center gap-2"><Network className="h-5 w-5" /> Health & Metrics</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex items-center gap-3">
                  {healthOk ? (
                    <span className="inline-flex items-center gap-2 text-emerald-700 font-medium"><CheckCircle2 className="h-5 w-5" /> Healthy</span>
                  ) : healthOk === false ? (
                    <span className="inline-flex items-center gap-2 text-red-700 font-medium"><AlertTriangle className="h-5 w-5" /> Unhealthy</span>
                  ) : (
                    <span className="inline-flex items-center gap-2 text-slate-600 font-medium"><Timer className="h-5 w-5" /> Checking…</span>
                  )}
                  <span className="text-xs text-slate-500">{healthMsg}</span>
                  <Button variant="ghost" size="icon" className="ml-auto" onClick={() => window.location.reload()}>
                    <RefreshCcw className="h-4 w-4" />
                  </Button>
                </div>
                <div className="h-48">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={metricsSeries} margin={{ top: 5, right: 20, left: 0, bottom: 5 }}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis dataKey="t" tick={{ fontSize: 12 }} />
                      <YAxis allowDecimals={false} tick={{ fontSize: 12 }} />
                      <RTooltip />
                      <Line type="monotone" dataKey="value" strokeWidth={2} dot={false} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
                <details className="text-sm">
                  <summary className="cursor-pointer font-medium">Raw Prometheus metrics</summary>
                  <pre className="mt-2 max-h-64 overflow-auto bg-slate-50 border rounded p-2 text-xs whitespace-pre-wrap">{metricsRaw || "(no data)"}</pre>
                </details>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2"><Shield className="h-5 w-5" /> Security</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                <p><strong>Auth:</strong> All requests send <code>X-Api-Key</code> (and <code>Admin-Key</code> if provided).</p>
                <p><strong>Integrity:</strong> Upload responses surface SHA-256 checksum. Use it to verify downloads.</p>
                <p><strong>Idempotency:</strong> Uploads/versions include <code>Idempotency-Key</code> when enabled.</p>
                <p className="text-slate-600">For internal TLS to MinIO and SSE at rest, enable these on the server side. This UI doesn’t alter server configs.</p>
              </CardContent>
            </Card>
          </div>

          <Tabs defaultValue="upload" className="w-full">
            <TabsList className="gap-2 w-full">
              <TabsTrigger value="upload">Upload</TabsTrigger>
              <TabsTrigger value="download-id">Download by ID</TabsTrigger>
              <TabsTrigger value="version">New Version (PUT)</TabsTrigger>
              <TabsTrigger value="delete">Delete</TabsTrigger>
            </TabsList>

            <TabsContent value="upload" className="mt-4">
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2"><Upload className="h-5 w-5" /> Upload File</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4 items-end">
                    <div className="space-y-2 md:col-span-2">
                      <Label htmlFor="dir">Repository Directory</Label>
                      <Input id="dir" placeholder="projects/demo" value={uploadDir} onChange={(e) => setUploadDir(e.target.value)} />
                      <p className="text-xs text-slate-500">This preserves your directory structure requirement.</p>
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="file">Choose File</Label>
                      <Input id="file" type="file" onChange={(e) => setUploadFile(e.target.files?.[0] || null)} />
                    </div>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-3">
                      <Switch id="idem" checked={autoIdem} onCheckedChange={setAutoIdem} />
                      <Label htmlFor="idem">Auto Idempotency-Key</Label>
                    </div>
                    <Button onClick={handleUpload} className="gap-2"><Upload className="h-4 w-4" /> Upload</Button>
                  </div>
                  <Separator />
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div>
                      <Label className="text-xs">Last Upload File ID</Label>
                      <div className="rounded border p-2 text-sm bg-slate-50 break-all">{lastUploadId || "—"}</div>
                    </div>
                    <div>
                      <Label className="text-xs">Last Upload SHA-256</Label>
                      <div className="rounded border p-2 text-sm bg-slate-50 break-all">{lastUploadChecksum || "—"}</div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="download-id" className="mt-4">
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2"><Download className="h-5 w-5" /> Download by ID</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4 items-end">
                    <div className="space-y-2 md:col-span-2">
                      <Label htmlFor="dl-id">File ID</Label>
                      <Input id="dl-id" placeholder="94e1f5bbac8b4f4e9685636c603149af" value={dlId} onChange={(e) => setDlId(e.target.value)} />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="dl-ver">Version (optional)</Label>
                      <Input id="dl-ver" placeholder="v2 or 2" value={dlVersion} onChange={(e) => setDlVersion(e.target.value)} />
                    </div>
                  </div>
                  <Button onClick={handleDownloadById} className="gap-2"><Download className="h-4 w-4" /> Download</Button>
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="version" className="mt-4">
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2"><Hash className="h-5 w-5" /> Upload New Version</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4 items-end">
                    <div className="space-y-2 md:col-span-2">
                      <Label htmlFor="put-id">File ID</Label>
                      <Input id="put-id" placeholder="94e1f5bbac8b4f4e9685636c603149af" value={putId} onChange={(e) => setPutId(e.target.value)} />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="put-file">Choose File</Label>
                      <Input id="put-file" type="file" onChange={(e) => setPutFile(e.target.files?.[0] || null)} />
                    </div>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-3">
                      <Switch id="idem2" checked={autoIdem} onCheckedChange={setAutoIdem} />
                      <Label htmlFor="idem2">Auto Idempotency-Key</Label>
                    </div>
                    <Button onClick={handlePutVersion} className="gap-2"><Upload className="h-4 w-4" /> Upload Version</Button>
                  </div>
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="delete" className="mt-4">
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2"><Trash2 className="h-5 w-5" /> Delete by ID</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4 items-end">
                    <div className="space-y-2 md:col-span-2">
                      <Label htmlFor="del-id">File ID</Label>
                      <Input id="del-id" placeholder="94e1f5bbac8b4f4e9685636c603149af" value={delId} onChange={(e) => setDelId(e.target.value)} />
                    </div>
                    <div className="space-y-2">
                      <Label className="invisible">Delete</Label>
                      <Button variant="destructive" onClick={handleDeleteId} className="w-full">Delete</Button>
                    </div>
                  </div>
                  <p className="text-xs text-slate-600">This calls <code>DELETE /v1/files/&lt;id&gt;</code> and preserves error transparency.</p>
                </CardContent>
              </Card>
            </TabsContent>
          </Tabs>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2"><FileIcon className="h-5 w-5" /> Request Log (live)</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="overflow-auto">
                <table className="w-full text-sm">
                  <thead className="text-left">
                    <tr className="border-b">
                      <th className="py-2 pr-3">When</th>
                      <th className="py-2 pr-3">Method</th>
                      <th className="py-2 pr-3">URL</th>
                      <th className="py-2 pr-3">Status</th>
                      <th className="py-2 pr-3">Duration</th>
                      <th className="py-2 pr-3">Bytes</th>
                      <th className="py-2 pr-3">Note</th>
                    </tr>
                  </thead>
                  <tbody>
                    {logs.map((l) => (
                      <tr key={l.id} className="border-b last:border-0">
                        <td className="py-2 pr-3 whitespace-nowrap">{new Date(l.when).toLocaleTimeString()}</td>
                        <td className="py-2 pr-3">{l.method}</td>
                        <td className="py-2 pr-3 max-w-[420px] truncate" title={l.url}>{l.url}</td>
                        <td className="py-2 pr-3">{l.ok == null ? "—" : l.ok ? "OK" : l.status}</td>
                        <td className="py-2 pr-3">{ms(l.durationMs)}</td>
                        <td className="py-2 pr-3">{l.bytes ?? "—"}</td>
                        <td className="py-2 pr-3">{l.note || ""}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="text-xs text-slate-500 mt-2">Use these timings to validate the ≤200 ms average response time requirement under normal load.</p>
            </CardContent>
          </Card>

          <footer className="text-center text-xs text-slate-500 pb-8">
          </footer>
        </div>
      </div>
    </TooltipProvider>
  );
}

// -----------------------
// Settings Panel Component
// -----------------------

function SettingsPanel(props: {
  baseUrl: string;
  setBaseUrl: (v: string) => void;
  apiKey: string;
  setApiKey: (v: string) => void;
  adminKey: string;
  setAdminKey: (v: string) => void;
  autoIdem: boolean;
  setAutoIdem: (v: boolean) => void;
}) {
  const { baseUrl, setBaseUrl, apiKey, setApiKey, adminKey, setAdminKey, autoIdem, setAutoIdem } = props;
  const [showKeys, setShowKeys] = useState(false);

  return (
    <Card className="w-full md:w-[520px]">
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2"><Settings className="h-4 w-4" /> Settings</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div className="space-y-1">
            <Label htmlFor="base">Base URL</Label>
            <Input id="base" placeholder={DEFAULT_BASE_URL} value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="autoIdem">Idempotency</Label>
            <div className="flex items-center gap-3 border rounded px-3 py-2">
              <Switch id="autoIdem" checked={autoIdem} onCheckedChange={setAutoIdem} />
              <span className="text-sm">Auto-generate for write ops</span>
            </div>
          </div>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div className="space-y-1">
            <Label htmlFor="apikey">X-Api-Key</Label>
            <Input id="apikey" type={showKeys ? "text" : "password"} placeholder="••••••" value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="adminkey">Admin-Key (optional)</Label>
            <Input id="adminkey" type={showKeys ? "text" : "password"} placeholder="••••••" value={adminKey} onChange={(e) => setAdminKey(e.target.value)} />
          </div>
        </div>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Switch id="showkeys" checked={showKeys} onCheckedChange={setShowKeys} />
            <Label htmlFor="showkeys">Show keys</Label>
          </div>
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="text-xs text-slate-500 cursor-help">Self-signed TLS note</span>
            </TooltipTrigger>
            <TooltipContent>
              <p className="max-w-xs text-xs">If your Traefik certificate is self-signed, the browser may block requests. Either trust the CA locally or terminate TLS with a trusted cert for production.</p>
            </TooltipContent>
          </Tooltip>
        </div>
      </CardContent>
    </Card>
  );
}
