'use client';

/**
 * Form primitives for the design workbench.
 *
 * These exist because the workbench has to offer an editing surface for eleven
 * different kinds of record, each with its own fields, and writing that inline
 * produces the failure mode this component is meant to avoid: a "create" button
 * that opens a `window.prompt` and asks the user to paste a raw row id. That is
 * not an editable interface — it is the HTTP API with extra steps, and it pushes
 * people back to `curl`, which is exactly what the workbench is for.
 *
 * So field *selection* is declarative (a field list) and the form does the rest:
 * labelled control, required handling, a submit that reports its own refusal, and
 * a busy state that disables only itself. Every create in the workbench goes
 * through {@link CreateForm}, which means the phase gate can wrap one component
 * instead of being re-implemented eleven times — and forgotten once.
 *
 * A `tags` field is a textarea of one entry per line. That is deliberate: several
 * of these records (`minCriteria`, `verifyRules`, teaching-design buckets) are
 * genuinely lists, and a tag-chip widget would trade an honest representation for
 * a prettier one.
 */

import { useCallback, useState, type ReactNode } from 'react';
import { AlertTriangle, Loader2, Plus } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { authoringAvailability, type DesignAuthoring } from '@/lib/curriculum/design-editing';
import type { CurriculumDesignPhase } from '@/lib/curriculum/design-types';

export type FormField =
  | {
      kind: 'text';
      name: string;
      label: string;
      placeholder?: string;
      required?: boolean;
      initial?: string;
      /** Small print under the control; rendered, never only a tooltip. */
      hint?: string;
    }
  | {
      kind: 'textarea';
      name: string;
      label: string;
      placeholder?: string;
      required?: boolean;
      initial?: string;
      hint?: string;
    }
  | {
      kind: 'number';
      name: string;
      label: string;
      placeholder?: string;
      required?: boolean;
      initial?: string;
      hint?: string;
    }
  | {
      kind: 'select';
      name: string;
      label: string;
      options: { value: string; label: string }[];
      initial?: string;
      /**
       * A select can be empty when nothing is chosen, and an empty foreign key
       * is not "unset" — it is a lookup for a row with no id, which the server
       * answers 404. Marking the ones that are needed turns that into a local
       * sentence naming the field.
       */
      required?: boolean;
    }
  | {
      kind: 'tags';
      name: string;
      label: string;
      placeholder?: string;
      hint?: string;
      initial?: string;
    }
  | {
      kind: 'checkbox';
      name: string;
      label: string;
      initial?: boolean;
    };

export type FormValues = Record<string, string | boolean | string[]>;

/**
 * Turn a field list into a body.
 *
 * Kept separate from the form so a caller can post-process one value — the
 * coverage rows need ids joined, the question needs its options built — without
 * the form knowing anything about those records. An empty required field is
 * reported rather than posted, because the server would refuse it with a 400 that
 * reads like a schema problem rather than "you left this empty".
 */
export function fieldsToValues(fields: FormField[]): FormValues {
  const values: FormValues = {};
  for (const field of fields) {
    if (field.kind === 'checkbox') {
      values[field.name] = field.initial ?? false;
    } else if (field.kind === 'tags') {
      values[field.name] = (field.initial ?? '')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '');
    } else {
      values[field.name] = field.initial ?? '';
    }
  }
  return values;
}

/** The first missing required field, or `null` when the form is complete. */
export function missingRequired(fields: FormField[], values: FormValues): string | null {
  for (const field of fields) {
    if (!('required' in field) || !field.required) continue;
    const value = values[field.name];
    if (Array.isArray(value) ? value.length === 0 : !String(value ?? '').trim()) {
      return field.label;
    }
  }
  return null;
}

/**
 * One labelled control.
 *
 * The id is derived from the field name so `<Label htmlFor>` is always correct —
 * a label pointing at the wrong input is an accessibility defect that no type
 * check finds, and this component has eleven of them to get right.
 */
function FieldControl({
  field,
  value,
  onChange,
}: {
  field: FormField;
  value: string | boolean | string[];
  onChange: (next: string | boolean | string[]) => void;
}) {
  const id = `design-field-${field.name}`;

  if (field.kind === 'checkbox') {
    return (
      <label className="flex items-center gap-2 text-xs" htmlFor={id}>
        <input
          id={id}
          type="checkbox"
          className="size-4 accent-primary"
          checked={value === true}
          onChange={(event) => onChange(event.target.checked)}
        />
        {field.label}
      </label>
    );
  }

  if (field.kind === 'select') {
    return (
      <Select value={typeof value === 'string' ? value : ''} onValueChange={onChange}>
        <SelectTrigger id={id} className="h-8 text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {field.options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  }

  if (field.kind === 'tags') {
    const text = Array.isArray(value) ? value.join('\n') : String(value ?? '');
    return (
      <Textarea
        id={id}
        className="min-h-20 text-xs"
        value={text}
        placeholder={field.placeholder}
        onChange={(event) =>
          onChange(
            event.target.value
              .split('\n')
              .map((line) => line.trim())
              .filter((line) => line !== ''),
          )
        }
      />
    );
  }

  if (field.kind === 'textarea') {
    return (
      <Textarea
        id={id}
        className="min-h-16 text-xs"
        value={typeof value === 'string' ? value : ''}
        placeholder={field.placeholder}
        onChange={(event) => onChange(event.target.value)}
      />
    );
  }

  if (field.kind === 'number') {
    return (
      <Input
        id={id}
        type="number"
        className="text-xs"
        value={typeof value === 'string' ? value : ''}
        placeholder={field.placeholder}
        onChange={(event) => onChange(event.target.value)}
      />
    );
  }

  return (
    <Input
      id={id}
      className="text-xs"
      value={typeof value === 'string' ? value : ''}
      placeholder={field.placeholder}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

/**
 * A create form for one kind of authored record.
 *
 * The phase gate wraps the submit rather than the form: the fields stay visible
 * and readable while creation is closed, because a hidden form is
 * indistinguishable from a missing feature — which is how the workbench this
 * replaces ended up with create entry points that did nothing. The refusal
 * sentence is shown next to the button so the reason is never only a tooltip.
 */
export function CreateForm({
  kind,
  phase,
  fields,
  submitLabel,
  onSubmit,
  busyKey,
  busy,
  onCancel,
  extra,
}: {
  kind: DesignAuthoring;
  phase: CurriculumDesignPhase;
  fields: FormField[];
  submitLabel: string;
  onSubmit: (values: FormValues) => Promise<void>;
  busyKey: string;
  busy: string | null;
  onCancel?: () => void;
  /** Rendered under the fields — the node link editor, for instance. */
  extra?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<FormValues>(() => fieldsToValues(fields));
  const [localError, setLocalError] = useState<string | null>(null);

  const availability = authoringAvailability(phase, kind);
  const isBusy = busy === busyKey;

  const set = useCallback((name: string, value: string | boolean | string[]) => {
    setValues((current) => ({ ...current, [name]: value }));
  }, []);

  const submit = useCallback(async () => {
    const missing = missingRequired(fields, values);
    if (missing) {
      setLocalError(`请填写「${missing}」。`);
      return;
    }
    setLocalError(null);
    await onSubmit(values);
    // Only reset on the way out of the open state, so a failed write leaves the
    // author's text on screen to fix rather than clearing it under them.
    setValues(fieldsToValues(fields));
  }, [fields, onSubmit, values]);

  if (!open) {
    return (
      <Button
        size="sm"
        onClick={() => setOpen(true)}
        disabled={!availability.allowed || isBusy}
        title={availability.reason ?? undefined}
      >
        <Plus />
        {submitLabel}
      </Button>
    );
  }

  return (
    <div className="border-border bg-muted/20 flex w-full flex-col gap-2.5 rounded-lg border p-3">
      <div className="grid gap-2.5 sm:grid-cols-2">
        {fields.map((field) => (
          <div
            key={field.name}
            className={field.kind === 'textarea' || field.kind === 'tags' ? 'sm:col-span-2' : ''}
          >
            <Label className="mb-1 block text-[11px]" htmlFor={`design-field-${field.name}`}>
              {field.label}
              {'required' in field && field.required ? ' *' : ''}
            </Label>
            <FieldControl
              field={field}
              value={values[field.name]}
              onChange={(v) => set(field.name, v)}
            />
            {'hint' in field && field.hint ? (
              <span className="text-muted-foreground mt-1 block text-[10px]">{field.hint}</span>
            ) : null}
          </div>
        ))}
      </div>
      {extra}
      {!availability.allowed && (
        <p className="text-muted-foreground flex items-start gap-1.5 text-[11px]">
          <AlertTriangle className="mt-0.5 size-3 shrink-0" />
          {availability.reason}
        </p>
      )}
      {localError && <p className="text-destructive text-[11px]">{localError}</p>}
      <div className="flex gap-2">
        <Button size="sm" onClick={() => void submit()} disabled={!availability.allowed || isBusy}>
          {isBusy ? <Loader2 className="animate-spin" /> : <Plus />}
          {submitLabel}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setOpen(false);
            setLocalError(null);
            setValues(fieldsToValues(fields));
            onCancel?.();
          }}
        >
          取消
        </Button>
      </div>
    </div>
  );
}

/**
 * A one-line edit with an explicit save.
 *
 * Explicit rather than debounced-autosave, and the reason is in the workbench
 * header: several of these fields are refusable (a deck page with no goal, an
 * outcome whose criteria make it unverifiable), and an autosave that reports
 * success for a write the server declined is worse than no save at all.
 */
export function InlineEdit({
  rowId,
  field,
  label,
  value,
  onSave,
  busyKey,
  busy,
  multiline,
  placeholder,
}: {
  rowId: string;
  field: string;
  label: string;
  value: string;
  onSave: (next: string) => Promise<void>;
  busyKey: string;
  busy: string | null;
  multiline?: boolean;
  placeholder?: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const key = `${rowId}:${field}`;
  const current = draft ?? value;
  const dirty = draft !== null && draft !== value;
  const isBusy = busy === busyKey;

  return (
    <div className="flex flex-col gap-1">
      <Label className="text-muted-foreground text-[10px]" htmlFor={key}>
        {label}
      </Label>
      <div className="flex items-start gap-1.5">
        {multiline ? (
          <Textarea
            id={key}
            className="min-h-14 text-xs"
            value={current}
            placeholder={placeholder}
            onChange={(event) => setDraft(event.target.value)}
          />
        ) : (
          <Input
            id={key}
            className="text-xs"
            value={current}
            placeholder={placeholder}
            onChange={(event) => setDraft(event.target.value)}
          />
        )}
        <Button
          size="sm"
          variant="outline"
          disabled={!dirty || isBusy}
          onClick={() => {
            void onSave(draft ?? value).then(() => setDraft(null));
          }}
        >
          {isBusy ? <Loader2 className="animate-spin" /> : null}
          保存
        </Button>
      </div>
    </div>
  );
}
