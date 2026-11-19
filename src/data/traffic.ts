import type { TrafficConfig } from '../sim/types';
import traffic from './traffic.json';

/** Lane count comes from the road (src/data/road.json), so it is added by the caller. */
export const trafficConfig: Omit<TrafficConfig, 'lanes'> = traffic;
