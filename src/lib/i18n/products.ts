import type { ProductKind } from "@/domain/product";

/** What each product is called on screen and on paper. */
export const tgProduct: Record<ProductKind, string> = {
  chigit: "Чигит",
  kip: "Кип",
  ulyuk: "Улюк",
  puchoq: "Пучоқ",
};

/** One line saying what the thing actually is, for anyone new to the yard. */
export const tgProductHint: Record<ProductKind, string> = {
  chigit: "Тухми пахта — ба корхонаҳои равған",
  kip: "Нахи фишурда — то охири мавсим дар анбор",
  ulyuk: "Аз мошин нагузашт — фурӯхта ё дубора коркард",
  puchoq: "Барг ва хасу хошок",
};

export const tgBaleState: Record<string, string> = {
  IN_STOCK: "Дар анбор",
  SHIPPED: "Бор карда шуд",
  SOLD: "Фурӯхта шуд",
  REPRESSED: "Дубора фишурда шуд",
  VOID: "Бекор",
};
