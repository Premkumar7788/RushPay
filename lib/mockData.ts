// Static demo data for Gazebo / North Square. Pure data, no state; see store.ts for persistence.

export type MenuItem = { id: string; name: string; price: number; stall: string };

export const STALL = { id: 'GZ-04', name: 'Gazebo Stall #4 (Rolls & Snacks)', location: 'Gazebo' } as const;

export const MENU: MenuItem[] = [
  { id: 'paneer-roll', name: 'Gazebo Paneer Tikka Roll', price: 80, stall: 'Gazebo' },
  { id: 'lime-juice', name: 'North Square Fresh Lime Juice', price: 40, stall: 'North Square' },
  { id: 'corn-sandwich', name: 'AB3 Cheese Corn Grilled Sandwich', price: 70, stall: 'AB3' },
];

const price = (id: string) => {
  const item = MENU.find((m) => m.id === id);
  if (!item) throw new Error(`Unknown menu item: ${id}`);
  return item.price;
};

const P = 'paneer-roll', L = 'lime-juice', C = 'corn-sandwich';

const RAW_SEED: { orderId: string; items: string[]; minutesAgo: number }[] = [
  { orderId: '#090', items: [P, L], minutesAgo: 88 },
  { orderId: '#091', items: [P], minutesAgo: 84 },
  { orderId: '#092', items: [P, C, L], minutesAgo: 79 },
  { orderId: '#093', items: [P, C], minutesAgo: 73 },
  { orderId: '#094', items: [C, L], minutesAgo: 66 },
  { orderId: '#095', items: [P, P], minutesAgo: 60 },
  { orderId: '#096', items: [C], minutesAgo: 52 },
  { orderId: '#097', items: [P, P, L], minutesAgo: 45 },
  { orderId: '#098', items: [P, L], minutesAgo: 38 },
  { orderId: '#099', items: [L], minutesAgo: 31 },
  { orderId: '#100', items: [P, C], minutesAgo: 24 },
  { orderId: '#101', items: [P, P, C], minutesAgo: 16 },
  { orderId: '#102', items: [C, L], minutesAgo: 9 },
  { orderId: '#103', items: [C, L], minutesAgo: 3 },
];

export type SeedOrder = { orderId: string; items: string[]; amount: number; minutesAgo: number };

// 14 buffered orders totalling exactly ₹1,840, so the live demo order is #104.
export const SEED_ORDERS: SeedOrder[] = RAW_SEED.map((o) => ({
  ...o,
  amount: o.items.reduce((sum, id) => sum + price(id), 0),
}));

export const FIRST_LIVE_ORDER = 104;
export const DEFAULT_BALANCE = 320;
export const SEED_VOUCHER_LIMIT = 2000;
