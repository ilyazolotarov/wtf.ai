// A road graph with some roads missing, for simulated drives on roads the map lacks (a yard's exit, a lane OSM doesn't
// have): the car drives them, the navigator's map doesn't know them. Replay tools only.
import type { EdgeId, RoadGraph } from "../../src/nav/mapmatch/graph/road-graph";

/** `graph` without the `hidden` edges: they are near nothing, no junction leads onto them, no node lists them. */
export function withHiddenRoads<G extends RoadGraph>(graph: G, hidden: readonly EdgeId[]): G {
  if (!hidden.length) return graph;
  const gone = new Set<EdgeId>(hidden);
  return new Proxy(graph, {
    get(target, prop, receiver) {
      if (prop === "edgesNear") return (e: number, n: number, r: number) => target.edgesNear(e, n, r).filter((x) => !gone.has(x.edge.id));
      if (prop === "exits") return (via: EdgeId, dir: 1 | -1) => target.exits(via, dir).filter((x) => !gone.has(x.edge));
      if (prop === "node") {
        return (id: Parameters<G["node"]>[0]) => {
          const node = target.node(id);
          return { ...node, edges: node.edges.filter((x) => !gone.has(x.edge)) };
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
