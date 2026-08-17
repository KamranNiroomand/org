import * as Dialog from '@radix-ui/react-dialog';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import type {
  ButtonHTMLAttributes,
  HTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  Ref,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from 'react';

export const cn = (...inputs: ClassValue[]) => twMerge(clsx(inputs));

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('rounded-xl border border-border bg-panel', className)}
      style={{ boxShadow: 'var(--shadow)' }}
      {...props}
    />
  );
}

export function CardHeader({
  title,
  subtitle,
  action,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-border px-4 py-3">
      <div className="min-w-0">
        <h2 className="truncate text-sm font-semibold">{title}</h2>
        {subtitle && <p className="mt-0.5 truncate text-xs text-muted">{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'sm' | 'md';
};

export function Button({ variant = 'secondary', size = 'md', className, ...props }: ButtonProps) {
  return (
    <button
      className={cn(
        'inline-flex shrink-0 items-center justify-center gap-1.5 rounded-lg font-medium whitespace-nowrap transition-colors',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
        'disabled:pointer-events-none disabled:opacity-45',
        size === 'sm' ? 'h-7 px-2.5 text-xs' : 'h-9 px-3.5 text-sm',
        variant === 'primary' && 'bg-accent text-white hover:opacity-90',
        variant === 'secondary' && 'border border-border bg-panel hover:bg-bg-subtle',
        variant === 'ghost' && 'hover:bg-bg-subtle',
        variant === 'danger' && 'text-negative hover:bg-negative/10',
        className,
      )}
      {...props}
    />
  );
}

export function Input({
  className,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { ref?: Ref<HTMLInputElement> }) {
  return (
    <input
      className={cn(
        'h-9 w-full rounded-lg border border-border bg-bg px-3 text-sm',
        'placeholder:text-faint focus:border-accent focus:outline-none',
        className,
      )}
      {...props}
    />
  );
}

export function Textarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      className={cn(
        'w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm leading-relaxed',
        'placeholder:text-faint focus:border-accent focus:outline-none',
        'min-h-20 resize-none',
        className,
      )}
      {...props}
    />
  );
}

/**
 * A native select, deliberately. The platform control is already keyboard- and
 * screen-reader-perfect, and on a desktop app there is nothing a scripted
 * listbox would buy that is worth reimplementing those two things badly.
 */
export function Select({
  options,
  className,
  ...props
}: Omit<SelectHTMLAttributes<HTMLSelectElement>, 'children'> & {
  options: Array<[value: string, label: string]>;
}) {
  return (
    <select
      className={cn(
        'h-9 w-full rounded-lg border border-border bg-bg px-2 text-sm text-text',
        'focus:border-accent focus:outline-none',
        className,
      )}
      {...props}
    >
      {options.map(([value, label]) => (
        <option key={value} value={value}>
          {label}
        </option>
      ))}
    </select>
  );
}

/**
 * A centred dialog. Unlike the command palette — which hides its title because
 * the search box is self-evident — a modal that edits something needs to say
 * what it is editing, so the title is visible and the description is only
 * hidden when the caller has nothing to add.
 */
export function Modal({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/25 backdrop-blur-[2px]" />
        <Dialog.Content
          className="fixed top-[12%] left-1/2 z-50 flex max-h-[76vh] w-[min(520px,92vw)] -translate-x-1/2 flex-col overflow-hidden rounded-xl border border-border bg-panel"
          style={{ boxShadow: 'var(--shadow)' }}
        >
          <div className="border-b border-border px-4 py-3">
            <Dialog.Title className="text-sm font-semibold">{title}</Dialog.Title>
            {description ? (
              <Dialog.Description className="mt-0.5 text-xs text-muted">
                {description}
              </Dialog.Description>
            ) : (
              // Radix warns without one, and a described dialog is better for a
              // screen reader than a silenced warning.
              <Dialog.Description className="sr-only">Edit the details below.</Dialog.Description>
            )}
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3.5">{children}</div>

          {footer && (
            <div className="flex items-center justify-between gap-2 border-t border-border px-4 py-3">
              {footer}
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function Badge({
  children,
  tone = 'neutral',
  className,
}: {
  children: ReactNode;
  tone?: 'neutral' | 'accent' | 'positive' | 'negative' | 'warning';
  className?: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-md px-1.5 py-0.5 text-[11px] font-medium',
        tone === 'neutral' && 'bg-bg-subtle text-muted',
        tone === 'accent' && 'bg-accent-soft text-accent',
        tone === 'positive' && 'bg-positive/12 text-positive',
        tone === 'negative' && 'bg-negative/12 text-negative',
        tone === 'warning' && 'bg-warning/15 text-warning',
        className,
      )}
    >
      {children}
    </span>
  );
}

/**
 * Empty states carry a suggestion, not just an apology. A blank tab should tell
 * you what to do next.
 */
export function Empty({
  icon,
  title,
  hint,
  action,
}: {
  icon?: ReactNode;
  title: string;
  hint?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-14 text-center">
      {icon && <div className="mb-3 text-faint">{icon}</div>}
      <p className="text-sm font-medium">{title}</p>
      {hint && <p className="mt-1 max-w-sm text-xs text-muted">{hint}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        'size-4 animate-spin rounded-full border-2 border-border border-t-accent',
        className,
      )}
    />
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('animate-pulse rounded-md bg-bg-subtle', className)} />;
}
