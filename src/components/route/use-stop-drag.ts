// Dragging a stop to another place in the trip by its handle (STOPS-SPEC §7.1): the row follows the finger, the stops
// it passes make room, and the drop moves the stop there (one plan, as any change to the stops).

import { useMemo, useState } from "react";
import { Animated, PanResponder, type GestureResponderHandlers, type LayoutChangeEvent } from "react-native";

interface Row {
  top: number;
  height: number;
}

/** The place among `count` stops for the row `from` dragged by `dy`: past the middles of those it went beyond. */
export function dropPlace(rows: readonly (Row | undefined)[], count: number, from: number, dy: number): number {
  const at = rows[from];
  if (!at) return from;
  const middle = at.top + at.height / 2 + dy;
  let to = 0;
  for (let k = 0; k < count; k++) {
    const r = rows[k];
    if (k !== from && r && r.top + r.height / 2 < middle) to++;
  }
  return to;
}

interface Drag {
  from: number;
  /** Where it would go if dropped now. */
  to: number;
  /** From the dragged row's top to the next row's: how far the rows it passes move to make room. */
  pitch: number;
}

/**
 * The stops' rows (`keys`), laid out one after another in the same parent, then the row after them (`layout` at
 * `keys.length`: its top ends the last stop's slot). `move(key, delta)` on a drop to another place; `onDragging` while
 * a row is held (the page stops scrolling, which would take the finger away). The responders stay the same while the
 * stops and their rows do: a new one in the middle of a drag would lose it.
 */
export function useStopDrag(keys: readonly string[], move: (key: string, delta: number) => void, onDragging: (on: boolean) => void) {
  const [rows, setRows] = useState<Row[]>([]);
  const [dy] = useState(() => new Animated.Value(0));
  const [drag, setDrag] = useState<Drag | null>(null);

  const handlers = useMemo(() => {
    const ready = (i: number) => rows[i] !== undefined && rows[i + 1] !== undefined;
    const target = (from: number, d: number) => dropPlace(rows, keys.length, from, d);
    const end = (from: number, d: number, dropped: boolean) => {
      const to = target(from, d);
      dy.setValue(0);
      setDrag(null);
      onDragging(false);
      if (dropped && to !== from) move(keys[from], to - from);
    };
    return keys.map(
      (_, i): GestureResponderHandlers =>
        PanResponder.create({
          onStartShouldSetPanResponder: () => ready(i),
          onMoveShouldSetPanResponder: () => ready(i),
          // The page's scrolling never takes a held row away.
          onPanResponderTerminationRequest: () => false,
          onPanResponderGrant: () => {
            dy.setValue(0);
            setDrag({ from: i, to: i, pitch: rows[i + 1].top - rows[i].top });
            onDragging(true);
          },
          onPanResponderMove: (_e, g) => {
            dy.setValue(g.dy);
            const to = target(i, g.dy);
            setDrag((d) => (d && d.to !== to ? { ...d, to } : d));
          },
          onPanResponderRelease: (_e, g) => end(i, g.dy, true),
          onPanResponderTerminate: (_e, g) => end(i, g.dy, false),
        }).panHandlers,
    );
  }, [keys, rows, dy, move, onDragging]);

  return {
    handlers,
    /** The row's place, for `onLayout` of each stop's row and of the row after them. */
    layout: (i: number) => (e: LayoutChangeEvent) => {
      const { y, height } = e.nativeEvent.layout;
      setRows((r) => {
        if (r[i]?.top === y && r[i]?.height === height) return r;
        const next = [...r];
        next[i] = { top: y, height };
        return next;
      });
    },
    /** The row's offset while one is dragged: the dragged one with the finger, those it passed by its slot. */
    offset: (i: number) => {
      if (!drag) return null;
      if (i === drag.from) return { transform: [{ translateY: dy }], zIndex: 1 };
      if (drag.from < i && i <= drag.to) return { transform: [{ translateY: -drag.pitch }] };
      if (drag.to <= i && i < drag.from) return { transform: [{ translateY: drag.pitch }] };
      return null;
    },
  };
}
