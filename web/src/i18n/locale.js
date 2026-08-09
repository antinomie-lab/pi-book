import { computed, ref, watch } from "vue";
import {
  DEFAULT_LOCALE,
  LOCALE_KEY,
  locales,
  messages,
} from "./messages.js";

function readStoredLocale() {
  try {
    const value = localStorage.getItem(LOCALE_KEY);
    if (locales.some((l) => l.code === value)) return value;
  } catch {
    // Storage may be unavailable.
  }
  return null;
}

function detectLocale() {
  const stored = readStoredLocale();
  if (stored) return stored;
  const nav = (navigator.language || "").toLowerCase();
  if (nav.startsWith("zh")) return "zh";
  if (nav.startsWith("es")) return "es";
  if (nav.startsWith("en")) return "en";
  return DEFAULT_LOCALE;
}

const locale = ref(detectLocale());

function applyDocumentLocale(code) {
  const htmlLang = code === "zh" ? "zh-CN" : code;
  document.documentElement.lang = htmlLang;
  document.documentElement.dataset.locale = code;
  const title = messages[code]?.pageTitle;
  if (title) document.title = title;
}

applyDocumentLocale(locale.value);

watch(locale, (code) => {
  applyDocumentLocale(code);
  try {
    localStorage.setItem(LOCALE_KEY, code);
  } catch {
    // Selection still works when storage is unavailable.
  }
});

export function useLocale() {
  const t = computed(() => messages[locale.value] ?? messages[DEFAULT_LOCALE]);
  const currentLocale = computed(
    () => locales.find((l) => l.code === locale.value) ?? locales[0],
  );

  function setLocale(code) {
    if (!locales.some((l) => l.code === code)) return;
    locale.value = code;
  }

  return {
    locale,
    locales,
    t,
    currentLocale,
    setLocale,
  };
}
