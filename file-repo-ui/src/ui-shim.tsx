import React, { createContext, useContext, useMemo, useState } from "react";

type DivProps = React.HTMLAttributes<HTMLDivElement>;
type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "default"|"destructive"|"ghost"; size?: "icon"|"default" };
type InputProps = React.InputHTMLAttributes<HTMLInputElement>;
type LabelProps = React.LabelHTMLAttributes<HTMLLabelElement>;
type TextareaProps = React.TextareaHTMLAttributes<HTMLTextAreaElement>;

// ---- Card ----
export const Card = ({ className = "", ...p }: DivProps) => (
  <div className={`rounded-2xl border bg-white shadow-sm ${className}`} {...p} />
);
export const CardHeader = ({ className = "", ...p }: DivProps) => (
  <div className={`px-4 py-3 border-b ${className}`} {...p} />
);
export const CardTitle = ({ className = "", ...p }: DivProps) => (
  <div className={`font-medium ${className}`} {...p} />
);
export const CardContent = ({ className = "", ...p }: DivProps) => (
  <div className={`p-4 ${className}`} {...p} />
);

// ---- Button ----
export const Button = ({ className = "", variant = "default", size="default", ...p }: ButtonProps) => {
  const base = "inline-flex items-center justify-center rounded text-sm transition-colors";
  const pad = size === "icon" ? "h-9 w-9" : "px-4 py-2";
  const style =
    variant === "destructive" ? "bg-red-600 text-white hover:bg-red-500" :
    variant === "ghost" ? "border bg-white hover:bg-slate-50" :
    "bg-slate-900 text-white hover:bg-slate-800";
  return <button className={`${base} ${pad} ${style} ${className}`} {...p} />;
};

// ---- Input / Label / Textarea ----
export const Input = ({ className = "", ...p }: InputProps) => (
  <input className={`w-full border rounded px-3 py-2 text-sm ${className}`} {...p} />
);
export const Label = ({ className = "", ...p }: LabelProps) => (
  <label className={`block text-sm font-medium ${className}`} {...p} />
);
export const Textarea = ({ className = "", ...p }: TextareaProps) => (
  <textarea className={`w-full border rounded px-3 py-2 text-sm ${className}`} {...p} />
);

// ---- Separator ----
export const Separator = ({ className = "", ...p }: DivProps) => (
  <div className={`border-t ${className}`} {...p} />
);

// ---- Switch ----
export const Switch = ({
  checked, onCheckedChange, className = "", ...rest
}: { checked?: boolean; onCheckedChange?: (v: boolean)=>void; className?: string } & React.InputHTMLAttributes<HTMLInputElement>) => (
  <input
    type="checkbox"
    role="switch"
    checked={!!checked}
    onChange={(e) => onCheckedChange?.(e.target.checked)}
    className={`appearance-none inline-block w-10 h-6 rounded-full bg-slate-300 relative transition ${checked ? "bg-slate-900" : ""} ${className}`}
    {...rest}
  />
);

// ---- Tabs (tiny stateful version) ----
type TabsCtx = { value: string; setValue: (v: string)=>void };
const Ctx = createContext<TabsCtx | null>(null);

export const Tabs = ({
  defaultValue, value, onValueChange, className = "", children
}: { defaultValue?: string; value?: string; onValueChange?: (v: string)=>void; className?: string; children: React.ReactNode }) => {
  const [internal, setInternal] = useState<string>(defaultValue || "");
  const val = value ?? internal;
  const setValue = (v: string) => { onValueChange ? onValueChange(v) : setInternal(v); };
  const ctx = useMemo(() => ({ value: val, setValue }), [val]);
  return <div className={className}><Ctx.Provider value={ctx}>{children}</Ctx.Provider></div>;
};

export const TabsList = ({ className = "", ...p }: DivProps) => (
  <div className={`grid grid-flow-col auto-cols-fr w-full rounded border overflow-hidden ${className}`} {...p} />
);
export const TabsTrigger = ({ value, className = "", children }:
  { value: string; className?: string; children: React.ReactNode }) => {
  const ctx = useContext(Ctx)!;
  const active = ctx.value === value;
  return (
    <button
      onClick={() => ctx.setValue(value)}
      className={`px-3 py-2 text-sm ${active ? "bg-slate-900 text-white" : "bg-white hover:bg-slate-50"} ${className}`}
    >
      {children}
    </button>
  );
};
export const TabsContent = ({ value, className = "", children }:
  { value: string; className?: string; children: React.ReactNode }) => {
  const ctx = useContext(Ctx)!;
  if (ctx.value !== value) return null;
  return <div className={className}>{children}</div>;
};

// ---- Tooltip (no-op wrappers; accept asChild like shadcn) ----
export const TooltipProvider = ({ children }: { children: React.ReactNode }) => <>{children}</>;
export const Tooltip = ({ children }: { children: React.ReactNode }) => <>{children}</>;
export const TooltipTrigger = ({ children, asChild, ...rest }:
  { children: React.ReactNode; asChild?: boolean } & React.HTMLAttributes<HTMLSpanElement>) => (
  <span {...rest}>{children}</span>
);
export const TooltipContent = ({ children, className = "" }:
  { children: React.ReactNode; className?: string }) => (
  <div className={`inline-block text-xs text-slate-700 ${className}`}>{children}</div>
);
