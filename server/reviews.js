// "What's popular here?" without any AI: count how many reviews mention each well-known food or drink.
// With only ~5 reviews per cafe this is a hint, not a verdict, so callers show it as "mentioned in N reviews".

const MENU = [
  // coffee & drinks
  ['flat white', ['flat white', 'flat whites']],
  ['latte', ['latte', 'lattes']],
  ['cappuccino', ['cappuccino', 'cappuccinos', 'cappucino']],
  ['espresso', ['espresso', 'espressos']],
  ['americano', ['americano']],
  ['mocha', ['mocha']],
  ['cortado', ['cortado']],
  ['macchiato', ['macchiato']],
  ['cold brew', ['cold brew']],
  ['iced coffee', ['iced coffee', 'iced latte']],
  ['filter coffee', ['filter coffee', 'pour over', 'pour-over', 'v60', 'batch brew']],
  ['matcha', ['matcha']],
  ['chai', ['chai']],
  ['hot chocolate', ['hot chocolate', 'hot choc']],
  ['tea', ['tea', 'teas']],
  ['smoothie', ['smoothie', 'smoothies']],
  ['fresh juice', ['fresh juice', 'orange juice']],
  // bakery & sweets
  ['croissant', ['croissant', 'croissants']],
  ['pastries', ['pastry', 'pastries']],
  ['cake', ['cake', 'cakes']],
  ['cheesecake', ['cheesecake']],
  ['brownie', ['brownie', 'brownies']],
  ['cookie', ['cookie', 'cookies']],
  ['cinnamon bun', ['cinnamon bun', 'cinnamon buns', 'cinnamon roll', 'cinnamon rolls']],
  ['cardamom bun', ['cardamom bun', 'cardamom buns']],
  ['banana bread', ['banana bread']],
  ['scone', ['scone', 'scones']],
  ['muffin', ['muffin', 'muffins']],
  ['donut', ['donut', 'donuts', 'doughnut', 'doughnuts']],
  ['tiramisu', ['tiramisu']],
  ['pie', ['pie', 'pies']],
  // savoury & meals
  ['sandwich', ['sandwich', 'sandwiches', 'toastie', 'toasties']],
  ['bagel', ['bagel', 'bagels']],
  ['avocado toast', ['avocado toast', 'avo toast', 'smashed avo']],
  ['eggs benedict', ['eggs benedict', 'eggs benny']],
  ['pancakes', ['pancake', 'pancakes']],
  ['waffles', ['waffle', 'waffles']],
  ['french toast', ['french toast']],
  ['sourdough', ['sourdough']],
  ['granola', ['granola']],
  ['porridge', ['porridge']],
  ['soup', ['soup']],
  ['salad', ['salad', 'salads']],
  ['burger', ['burger', 'burgers']],
  ['pizza', ['pizza', 'pizzas']],
  ['pasta', ['pasta']],
  ['brunch', ['brunch']],
  ['breakfast', ['breakfast']],
];

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const PATTERNS = MENU.map(([item, variants]) => [item, new RegExp(`\\b(?:${variants.map(escapeRe).join('|')})\\b`, 'i')]);

/** @param {{text: string}[]} reviews  @returns {{item: string, mentions: number}[]} most-mentioned first (max 6) */
export function popularItems(reviews, limit = 6) {
  const counts = new Map();
  for (const r of reviews) {
    const text = r?.text || '';
    for (const [item, re] of PATTERNS) if (re.test(text)) counts.set(item, (counts.get(item) || 0) + 1); // once per review
  }
  return [...counts]
    .map(([item, mentions]) => ({ item, mentions }))
    .sort((a, b) => b.mentions - a.mentions || a.item.localeCompare(b.item))
    .slice(0, limit);
}
