import type { LucideIcon } from "lucide-react";
import {
  Beef,
  Candy,
  ChefHat,
  Coffee,
  Cookie,
  Croissant,
  CupSoda,
  Flame,
  GlassWater,
  IceCream2,
  LeafyGreen,
  Martini,
  Pizza,
  Salad,
  Sandwich,
  Soup,
  Sparkles,
  UtensilsCrossed,
  Wheat,
} from "lucide-react";

export const CATEGORY_ICON_MAP: Record<string, LucideIcon> = {
  "utensils-crossed": UtensilsCrossed,
  pizza: Pizza,
  sparkles: Sparkles,
  soup: Soup,
  wheat: Wheat,
  flame: Flame,
  cookie: Cookie,
  sandwich: Sandwich,
  salad: Salad,
  "ice-cream": IceCream2,
  coffee: Coffee,
  "cup-soda": CupSoda,
  "glass-water": GlassWater,
  croissant: Croissant,
  beef: Beef,
  candy: Candy,
  "chef-hat": ChefHat,
  "leafy-green": LeafyGreen,
  martini: Martini,
};

export function CategoryIcon({
  iconKey,
  className,
}: {
  iconKey: string;
  className?: string;
}) {
  const Icon = CATEGORY_ICON_MAP[iconKey] ?? UtensilsCrossed;
  return <Icon className={className} aria-hidden />;
}
