/**
 * Backdrop close for overlays
 *
 * A click whose press started inside a dialog and ended on the backdrop is
 * delivered to the backdrop, the element that holds both ends. Closing on any
 * backdrop click therefore closed a dialog when a press on one of its items
 * drifted past the edge, and the item never got its click. The backdrop closes
 * only when the press also started on it.
 */

import { useCallback, useRef } from 'preact/hooks';

export function useBackdropClose(onClose: (() => void) | undefined) {
	const pressedOnBackdrop = useRef(false);
	const onPointerDown = useCallback((e: PointerEvent) => {
		pressedOnBackdrop.current = e.target === e.currentTarget;
	}, []);
	const onClick = useCallback((e: MouseEvent) => {
		const fromBackdrop = pressedOnBackdrop.current && e.target === e.currentTarget;
		pressedOnBackdrop.current = false;
		if (fromBackdrop) onClose?.();
	}, [onClose]);
	return { onPointerDown, onClick };
}
