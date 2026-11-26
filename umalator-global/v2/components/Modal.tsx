/**
 * Modal Component
 * Base modal with header, body, and footer sections
 *
 * Copyright (c) 2026 TheCing (https://github.com/TheCing/uma-tools)
 * Licensed under GPL-3.0-or-later
 */

import { h } from 'preact';
import type { ComponentChildren } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import { X } from 'lucide-react';
import { useBackdropClose } from './backdrop';

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
let modalSeq = 0;

interface ModalProps {
	isOpen: boolean;
	onClose: () => void;
	title?: string;
	children: ComponentChildren;
	footer?: ComponentChildren;
	size?: 'sm' | 'md' | 'lg' | 'xl';
	closeOnBackdrop?: boolean;
	closeOnEscape?: boolean;
	className?: string;
}

export function Modal({
	isOpen,
	onClose,
	title,
	children,
	footer,
	size = 'md',
	closeOnBackdrop = true,
	closeOnEscape = true,
	className = ''
}: ModalProps) {
	const panelRef = useRef<HTMLDivElement>(null);
	const backdrop = useBackdropClose(closeOnBackdrop ? onClose : undefined);
	const titleId = useRef(`v2-modal-title-${++modalSeq}`).current;

	// A dialog takes focus when it opens, keeps Tab inside it, and gives focus
	// back to what opened it when it closes.
	useEffect(() => {
		if (!isOpen) return;
		const opener = document.activeElement as HTMLElement | null;
		const panel = panelRef.current;
		const first = panel?.querySelector<HTMLElement>(FOCUSABLE);
		(first ?? panel)?.focus();
		function trapTab(e: KeyboardEvent) {
			if (e.key !== 'Tab' || !panel) return;
			const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(el => el.offsetParent !== null);
			if (!items.length) { e.preventDefault(); panel.focus(); return; }
			const head = items[0], tail = items[items.length - 1];
			const at = document.activeElement;
			if (e.shiftKey && (at === head || !panel.contains(at))) { e.preventDefault(); tail.focus(); }
			else if (!e.shiftKey && (at === tail || !panel.contains(at))) { e.preventDefault(); head.focus(); }
		}
		document.addEventListener('keydown', trapTab);
		return () => {
			document.removeEventListener('keydown', trapTab);
			if (opener && document.contains(opener)) opener.focus();
		};
	}, [isOpen]);

	// Close on escape
	useEffect(() => {
		function handleEscape(e: KeyboardEvent) {
			if (e.key === 'Escape' && closeOnEscape) {
				onClose();
			}
		}
		if (isOpen) {
			document.addEventListener('keydown', handleEscape);
			document.body.style.overflow = 'hidden';
			return () => {
				document.removeEventListener('keydown', handleEscape);
				document.body.style.overflow = '';
			};
		}
	}, [isOpen, closeOnEscape, onClose]);

	if (!isOpen) return null;

	return (
		<div class="v2-modal-overlay" {...backdrop}>
			<div
				ref={panelRef}
				class={`v2-modal v2-modal-${size} ${className}`}
				role="dialog"
				aria-modal="true"
				aria-labelledby={title ? titleId : undefined}
				tabIndex={-1}
				onClick={e => e.stopPropagation()}
			>
				{title && (
					<div class="v2-modal-header">
						<h2 class="v2-modal-title" id={titleId}>{title}</h2>
						<button
							type="button"
							class="v2-modal-close"
							onClick={onClose}
							aria-label="Close"
						>
							<X size={16} />
						</button>
					</div>
				)}

				<div class="v2-modal-body">
					{children}
				</div>

				{footer && (
					<div class="v2-modal-footer">
						{footer}
					</div>
				)}
			</div>
		</div>
	);
}
