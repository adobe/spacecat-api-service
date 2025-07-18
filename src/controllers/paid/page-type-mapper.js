/*
 * Copyright 2025 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */
const regExRepo = {
  'bulk.com': [
    { name: 'homepage | Homepage', pattern: '^/[a-z]{2}/?$' },
    { name: 'blog | Reviews and Blog Content', pattern: '^/[a-z]{2}/(bulk-reviews|blog-[a-z0-9\\-]+)/?$' },
    { name: 'search | Search Results', pattern: '^/[a-z]{2}/(search|catalogsearch/result|search/go)/?$' },
    { name: 'landingpage | Goal-Based Landing Pages', pattern: '^/[a-z]{2}/(build-muscle-goal|change-your-diet-goal|perda-de-peso-2|dieta|gluten-free-diet|diet-protein-shakes)/?$' },
    { name: 'landingpage | Affiliate and Referral Programs', pattern: '^/[a-z]{2}/(programma-di-affiliazione|affiliate-programm|affiliates|programme-d-affilies|programme-de-parrainage|affiliate-scheme|affiliate-programma)/?$' },
    { name: 'landingpage | Membership and Loyalty', pattern: '^/[a-z]{2}/(boost/membership/info|mention-me/dashboard)/?$' },
    { name: 'productdetail | Product Detail Pages', pattern: '^/[a-z]{2}/(products/[a-z0-9\\-]+/[a-z0-9\\-]+(/[a-z0-9\\-]+)?|catalog/product/view/id/[0-9]+|[a-z0-9\\-]+\\.html)(/[a-z0-9\\-]+)*/?$' },
    { name: 'productlistpage | Protein Category', pattern: '^/[a-z]{2}/(protein|proteine|odzywki-bialkowe|proteinas)(/[a-z0-9\\-]+)*/?$' },
    { name: 'productlistpage | Vegan Category', pattern: '^/[a-z]{2}/vegan(/[a-z0-9\\-]+)*/?$' },
    { name: 'productlistpage | Sports Nutrition Category', pattern: '^/[a-z]{2}/(sports-nutrition|alimentazione-sportiva|sportnahrung|nutrition-sportive|sport-voeding|idrottsnutrition|sportsernaering|nutricion-deportiva|nutricao-desporto|odzywki-sportowe)(/[a-z0-9\\-]+)*/?$' },
    { name: 'productlistpage | Health Wellbeing Category', pattern: '^/[a-z]{2}/(health-wellbeing|saude-e-bem-estar|salute-e-benessere|halsa-och-valbefinnande|gesundheit-wohlbefinden|gezondheid-en-welzijn|sante-et-bien-etre|godt-helbred|salud-y-bienestar|zdrowie-i-dobre-samopoczucie)(/[a-z0-9\\-]+)*/?$' },
    { name: 'productlistpage | Vitamins Minerals Category', pattern: '^/[a-z]{2}/(vitamins|sante-et-bien-etre/multivitamins|gezondheid-en-welzijn/multivitaminen|salud-y-bienestar/multivitaminas|godt-helbred/multivitaminer)(/[a-z0-9\\-]+)*/?$' },
    { name: 'productlistpage | Food Category', pattern: '^/[a-z]{2}/(foods|nahrungsmittel|alimenti-2|livsmedel|voeding|produits-alimentaires|alimentos-saudaveis|madvarer|zywnosc|alimentacion)(/[a-z0-9\\-]+)*/?$' },
    { name: 'productlistpage | Weight Loss Category', pattern: '^/[a-z]{2}/(weight-loss|weight-loss-goal|gewichtsverlust|utrata-wagi|gewichtsafname|regime|vaegttab|viktminskning|perdita-di-peso)(/[a-z0-9\\-]+)*/?$' },
    { name: 'productlistpage | Accessories', pattern: '^/[a-z]{2}/(accessories|accessoires|zubehoer|accessori|accesorii|akcesoria|akcesoria-i-odziez|tilbehoer|tillbehoer|prislusenstvi|accessories-clothing|accessoires-en-kleding|vetements-accessoires|accessori-abbigliamento|ropa-y-accessorios|zubehor-und-bekleidung|zubehor-bekleidung|serie/accessories|selectionner-par-gamme/accessories|shoppa-via-produktutbud/accessories|shop-per-assortiment/accessories|selezione-per-gamma/accessories|shop-by-range/accessories|produktreihe/accessories|shop-efter-serie/accessories|comprar-por-gama/accessories|roupa-desportiva-e-acessorios|klader-och-tillbehor|tilbehor-toj|ropa-de-gimnasia)(/[a-z0-9\\-]+)*/?$' },
    { name: 'productlistpage | Daily Offers and Deals', pattern: '^/[a-z]{2}/(todays-offers|deal-of-the-day|offerta-del-giorno|dagens-tilbud|dagens-erbjudande|oferta-del-dia|special-sale|black-friday-rea|black-friday-sale|deal-des-tages|deal-du-jour|aanbod-van-de-dag|oferta-dnia)(-eu)?/?$' },
    { name: 'productlistpage | General Product Collections', pattern: '^/(collections|shop)/?$' },
    { name: 'productlistpage | Curated Collections and New Products', pattern: '^/[a-z]{2}/(unsere-favoriten|nouveaux-produits|nostri-preferiti|new-products|best-sellers-[a-z]{2}|vores-favoritter|vara-favoriter|nuestros-favoritos|nieuwe-producten|nuevos-productos|nuovi-prodotti|top-rated-products|de-retour-en-stock|out-stock|offerta-do-dia|geschenke-fur-veganer|saldi-black-friday|cyber-monday-rea|saffron-barker|selectionner-par-gamme|produktreihe|compare-pre-workout|first-time-orders|premiere-commande|studentenrabatt|freegift-[a-z]{2}|perda-de-peso-2/batidos-dieteticos)/?$' },
    { name: 'productlistpage | Special Promotions and Offers', pattern: '^/[a-z]{2}/(freewhey|double-[a-z]{2}|code-confirmation|code-exclusions)/?$' },
    { name: 'checkout | Cart Checkout', pattern: '^/([a-z]{2}/)*((ru/)?checkout|paypal/express/review|shop/checkout)/.*$' },
    { name: 'accountandorders | Order Tracking', pattern: '^/[a-z]{2}/trackmyorder/?$' },
    { name: 'accountandorders | My Account', pattern: '^/[a-z]{2}/(customer(/.*)?|sales/order/.*|reward/customer/.*)/?$' },
    { name: 'about | About Us', pattern: '^/[a-z]{2}/(about|sobre-nosotros|uber-uns|sobre-nos)/?$' },
    { name: 'about | Sustainability', pattern: '^/[a-z]{2}/ourplanet/?$' },
    { name: 'support | Customer Support', pattern: '^/[a-z]{2}/(contact|referafriend|recommander|invita-un-amico|student-discount|etudiants-promotions|descuentos-estudiantes|spend-save|bulk-boost|best-sellers|our-favourites|nos-favoris|onze-favorieten|a-propos-de-nous|delivery-faq|help|faq|support|contact-us|food-safety|clothing-returns)/?$' },
    { name: 'support | Email Preferences and Notifications', pattern: '^/[a-z]{2}/productalert/unsubscribe/email/product/[0-9]+/?$' },
    { name: 'support | Support Contact and Information', pattern: '^/(pages/contact|[a-z]{2}/(food-safety|clothing-returns))/?$' },
    { name: 'storelocator | Business and Wholesale', pattern: '^/(business|[a-z]{2}/wholesale)/?$' },
    { name: 'legal | Terms Conditions & Privacy Policy', pattern: '^/[a-z]{2}/(tc-exclusions|offer-terms|handelsbetingelser|impressum|privacy-policy|sitemap)(\\.html)?/?$' },
    { name: 'other | Other Pages', pattern: '.*' },
  ],
  'sunstargum.com': [
    { name: 'homepage | Sunstargum Homepage', pattern: '^/[a-z]{2}-[a-z]{2}/?$' },
    { name: 'productdetail | Product Detail Page', pattern: '^/[a-z]{2}-[a-z]{2}/(products|produkte|produkter|productos|produktai|produkti|produkty|producten|tuotteet|prodotti|produtos|soins-et-produits-dentaires|proionta)/(tandpastas|limpieza-interdental|colutorios|dantu-sepeteliai|hilos-dentales|product-page|zahnbuersten|interdentaire|szczoteczki-do-zebow|cepillos-de-dientes|tandborstar|dentifricos|tabletten|mellemrumsrengoring|mellemrumsrengoering|interdental-cleaners|toothpastes|dentifices|mundspuelungen|mundskoelj|munskoelj|enjuagues-y-geles-bucales|hammaslangat|hammastahnat|hammasharjat|suuvedet|.+)/.+\\.html$' },
    { name: 'productlistpage | All Products', pattern: '^/[a-z]{2}-[a-z]{2}/(products|produkte|produkter|productos|produktai|produkti|produkty|producten|tuotteet|prodotti|produtos|soins-et-produits-dentaires|proionta)\\.html$' },
    { name: 'productlistpage | Product Category Pages', pattern: '^/[a-z]{2}-[a-z]{2}/(products|produkte|produkter|productos|produktai|prodotti|produtos|soins-et-produits-dentaires|tuotteet)/(tandpastas|colutorios|dantu-sepeteliai|gel-e-spray|hammastahnat|suuvedet|.+)(\\.html)?$' },
    { name: 'landingpage | Campaign Landing Pages', pattern: '^/[a-z]{2}-[a-z]{2}/(kampagnen|campaigns|campagnes|campanas|kampanie|campagne)/[a-z0-9\\-]+\\.html$' },
    { name: 'about | About', pattern: '^/[a-z]{2}-[a-z]{2}/(about|about-us|company|who-we-are|chi-siamo|sobre-nosotros|uber-uns|om-os|om-oss|quem-somos|qui-sommes-nous|over-ons|o-nas)\\.html$' },
    { name: 'support | Support and Help', pattern: '^/[a-z]{2}-[a-z]{2}/(?:(support|faq|help|assistance|contact-us|customer-service|quienes-somos|uber-uns|om-os|om-oss|quem-somos|qui-sommes-nous|over-ons|o-nas)(/.*)?|.*/(faq|frequently-asked-questions)\\.html)$' },
    { name: 'support | Contact', pattern: '^/[a-z]{2}-[a-z]{2}/(?:(contact|contact-us|contactenos|contactanos|ota-yhteytta|neem-contact-met-ons-op|neem-contact)\\.html|(sobre-nosotros|quienes-somos)/(contactanos|contact-us|gum-contactanos)\\.html)$' },
    { name: 'storelocator | Where to Buy', pattern: '^/[a-z]{2}-[a-z]{2}/(store-locator|find-a-store|ou-trouver-nos-produits|where-to-buy|ou-acheter-nos-produits|donde-comprar|pou-na-agorasete|kopstallen|sklepy-internetowe|haendlersuche|forhandlere|war-te-koop|waar-te-koop|dove-comprare|mista-voin-ostaa-tuotteita|onde-comprar|kjop-her)(\\.html)?(/.+)?$' },
    { name: 'contentpage | Oral Health Content', pattern: '^/[a-z]{2}-[a-z]{2}/(oral-health|salute-orale|sante-bucco-dentaire|mundgesundheit|munnhelse|salud-oral|lexique|glosario-oral|zdrowie-jamy-ustnej|munhalsa|suun-terveys|mond-gezondheid|oralhelse|saude-bucal|stomatiki-ygeia)(\\.html)?(/.+)?$' },
    { name: 'legal | Legal and Privacy', pattern: '^/[a-z]{2}-[a-z]{2}/(privacy|terms|cookie|legal|rechtlich)(/.*)?$' },
    { name: 'other | Other Pages', pattern: '.*' },
  ],
  'wilson.com': [
    { name: 'homepage | Homepage', pattern: '^(/([a-z]{2}-[a-z]{2}))?/?$' },
    { name: 'productdetail | Product Detail Pages', pattern: '^(/([a-z]{2}-[a-z]{2}))?/product/[a-z0-9\\-]+$' },
    { name: 'productlistpage | Category Pages', pattern: '^(/([a-z]{2}-[a-z]{2}))?/(tennis|baseball|softball|golf|basketball|custom|sportswear|accessories|gloves|footwear|sale|apparel|bags|protective|equipment|deals|football|volleyball|pickleball|padel|fastpitch|shoes|specialty-shops|official-partnerships)(/|$)' },
    { name: 'search | Search Results', pattern: '^(/([a-z]{2}-[a-z]{2}))?/search(\\?.*)?$' },
    { name: 'checkout | Checkout Pages', pattern: '^(/([a-z]{2}-[a-z]{2}))?/checkout(/|$)' },
    { name: 'accountandorders | Login / Account / Wishlist / Order Pages', pattern: '^(/([a-z]{2}-[a-z]{2}))?/(login|account|register|customer|wishlist|d2x|sales)(/|$|/.*)' },
    { name: 'blog | Blog Articles', pattern: '^(/([a-z]{2}-[a-z]{2}))?/blog/.+$' },
    { name: 'blog | Blog Homepage', pattern: '^(/([a-z]{2}-[a-z]{2}))?/blog(/|$)' },
    { name: 'support | Support / Help / Warranty', pattern: '^(/([a-z]{2}-[a-z]{2}))?/(support|warranty|contact|returns|faqs|size-guide|explore/help(/.*)?)(/|$)' },
    { name: 'legal | Legal / Terms / Privacy', pattern: '^(/([a-z]{2}-[a-z]{2}))?/(terms|privacy|cookie-policy|accessibility|legal-notices|explore/terms-and-conditions|explore/legal)(/|$)' },
    { name: 'about | About / Brand / Company Info', pattern: '^(/([a-z]{2}-[a-z]{2}))?/(about|careers|store-locator|explore/(about-us|careers|sportswear/our-stores|first-responders-discount|healthcare-worker-discount|tennis/wilson-athletes|football/ada-ohio-factory))(/|$)' },
    { name: 'landingpage | Promo / Campaign / Landing Pages', pattern: '^(/([a-z]{2}-[a-z]{2}))?/(customize|custom-builder|landing/[a-z0-9\\-]+|explore/basketball/airless-prototype|explore/forms/.*|explore/shoes/.*|explore/sportswear/lookbook)(/|$)' },
    { name: 'contentpage | Content Pages', pattern: '^(/([a-z]{2}-[a-z]{2}))?/(technology|team-dealers|partnerships|ambassadors|history|giftcard/balance)(/|$)' },
    { name: '404 | 404 Not Found', pattern: '^(/([a-z]{2}-[a-z]{2}))?/404(/|$)' },
    { name: 'other | Other Pages', pattern: '.*' },
  ],
};

export function buildPageTypeCase(baseUrl, column = 'path') {
  if (!baseUrl) return null;

  let domain;
  try {
    domain = new URL(baseUrl).hostname.replace(/^www\./, '');
  } catch (e) {
    return null;
  }

  const rules = regExRepo[domain];
  if (!rules || !rules.length) return null;

  const caseLines = [
    'CASE',
    ...rules.map(({ name, pattern }) => `    WHEN REGEXP_LIKE(${column}, '${pattern}') THEN '${name.replace(/'/g, "''")}'`),
    "    ELSE 'other | Other Pages'",
    'END AS page_type',
  ];

  return caseLines.join('\n');
}

// For JS-side testing (not used in SQL)
export function mapPathToPageType(path, domain) {
  if (!domain) return 'other | Other Pages';
  const rules = regExRepo[domain];
  if (!rules) return 'other | Other Pages';
  for (const { name, pattern } of rules) {
    if (new RegExp(pattern).test(path)) {
      return name;
    }
  }
  return 'other | Other Pages';
}

// Utility to join baseUrl and path into a full URL
export function buildUrlFromBase(baseUrl, path) {
  if (!baseUrl || !path) return null;
  try {
    // Remove trailing slash from baseUrl and leading slash from path
    const cleanBase = baseUrl.replace(/\/$/, '');
    const cleanPath = path.replace(/^\//, '');
    return `${cleanBase}/${cleanPath}`;
  } catch (e) {
    return null;
  }
}

// Map an array of rows, adding a 'url' property to each using baseUrl and row.path
export function mapRowsWithUrl(rows, baseUrl) {
  if (!Array.isArray(rows)) return rows;
  return rows.map((row) => ({
    ...row,
    url: buildUrlFromBase(baseUrl, row.path),
  }));
}
