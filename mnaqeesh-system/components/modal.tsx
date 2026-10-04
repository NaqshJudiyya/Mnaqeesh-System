'use client';

import { useEffect, useRef } from 'react';

type Props = {
  open: boolean;
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
  /** `wide` is used by the content editor, whose preview needs room. */
  size?: 'normal' | 'wide';
};

/**
 * Modal dialog.
 *
 * Mirrors the extension's own Markdown editor dialog: a dimmed backdrop,
 * a titled header with a close button, and a footer for the actions.
 *
 * Closes on Escape and on a backdrop click, and locks background
 * scrolling while open, which is what people expect from a modal.
 */
export default function Modal({ open, title, subtitle, onClose, children, footer, size = 'normal' }: Props) {
  const panelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose();
    }

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    document.addEventListener('keydown', onKeyDown);

    // Move focus into the dialog so the keyboard starts inside it.
    window.requestAnimationFrame(() => panelRef.current?.focus());

    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="modal-backdrop" onMouseDown={(event) => {
      // Only a click that both starts and ends on the backdrop closes it,
      // so dragging a text selection out of the dialog does not dismiss it.
      if (event.target === event.currentTarget) onClose();
    }}>
      <div
        className={`modal-panel ${size === 'wide' ? 'modal-wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        ref={panelRef}
      >
        <div className="modal-head">
          <div>
            <h2>{title}</h2>
            {subtitle && <div className="modal-sub">{subtitle}</div>}
          </div>
          <button className="modal-close" type="button" onClick={onClose} title="إغلاق" aria-label="إغلاق">
            ×
          </button>
        </div>

        <div className="modal-body">{children}</div>

        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}
