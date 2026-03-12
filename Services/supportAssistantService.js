const axios = require("axios");

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const OPENAI_BASE_URL =
  process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";

const normalize = (value = "") =>
  value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const textCopy = {
  en: {
    greeting:
      "Hello. I can help with orders, payments, rewards, products, refunds, and support tickets.",
    capabilities:
      "I can answer store questions, explain order and payment status, check your loyalty progress, point you to product information, and help create a support ticket when a human review is needed.",
    gratitude: "You’re welcome. If you want, ask me about an order, payment, rewards, or a product.",
    unknown:
      "I do not have a fully confident answer for that yet. I can still guide you with store information or help create a support ticket for human follow-up.",
    escalate:
      "This looks like something human support should review. I can help you create a support ticket with the relevant context.",
  },
  fr: {
    greeting:
      "Bonjour. Je peux aider pour les commandes, paiements, points de fidelite, produits, remboursements et tickets support.",
    capabilities:
      "Je peux repondre aux questions sur la boutique, expliquer le statut des commandes et paiements, verifier la fidelite, donner des informations produit et aider a creer un ticket quand un agent humain doit intervenir.",
    gratitude:
      "Avec plaisir. Si vous voulez, posez-moi une question sur une commande, un paiement, la fidelite ou un produit.",
    unknown:
      "Je n’ai pas encore de reponse totalement fiable pour ce cas. Je peux quand meme vous guider avec les informations de la boutique ou aider a creer un ticket support.",
    escalate:
      "Ce cas devrait etre verifie par le support humain. Je peux vous aider a creer un ticket avec le contexte utile.",
  },
};

const categorizeIntent = (question) => {
  const normalizedQuestion = normalize(question);

  if (/^(hi|hello|hey|yo|salut|bonjour|bonsoir)\b/.test(normalizedQuestion)) {
    return "greeting";
  }

  if (/(thank|thanks|merci)\b/.test(normalizedQuestion)) {
    return "gratitude";
  }

  if (
    /(who are you|what can you do|help me|aide moi|que peux tu faire|what do you do)/.test(
      normalizedQuestion,
    )
  ) {
    return "capabilities";
  }

  if (/(refund|rembourse|key|cle|bug|issue|problem|echec|failed)/.test(normalizedQuestion)) {
    return "escalation";
  }

  return "store";
};

const scoreArticle = (article, question) => {
  const normalizedQuestion = normalize(question);
  const haystack = normalize(
    [
      article.title,
      article.question,
      article.summary,
      article.answer,
      ...(article.tags || []),
      article.category,
    ].join(" "),
  );

  const phraseBonus = haystack.includes(normalizedQuestion) ? 8 : 0;
  const terms = normalizedQuestion.split(" ").filter((term) => term.length > 2);

  const termScore = terms.reduce((total, term) => {
    if (haystack.includes(term)) {
      return total + 3;
    }

    return total;
  }, 0);

  return phraseBonus + termScore;
};

const buildContextLines = (locale, supportContext = {}) => {
  const lines = [];
  const userName = supportContext.user?.username;
  const recentOrder = supportContext.recentOrders?.[0];
  const loyalty = supportContext.loyalty;
  const featuredProducts = supportContext.featuredProducts || [];

  if (userName) {
    lines.push(
      locale === "fr"
        ? `Utilisateur connecte: ${userName}.`
        : `Signed-in user: ${userName}.`,
    );
  }

  if (recentOrder) {
    lines.push(
      locale === "fr"
        ? `Commande recente: ${recentOrder._id.toString().slice(-8).toUpperCase()}, statut ${recentOrder.status}, paiement ${recentOrder.paymentStatus}.`
        : `Recent order: ${recentOrder._id.toString().slice(-8).toUpperCase()}, status ${recentOrder.status}, payment ${recentOrder.paymentStatus}.`,
    );
  }

  if (loyalty) {
    lines.push(
      locale === "fr"
        ? `Fidelite: ${loyalty.points} points, niveau ${loyalty.tier}.`
        : `Loyalty: ${loyalty.points} points, tier ${loyalty.tier}.`,
    );
  }

  if (featuredProducts.length) {
    const names = featuredProducts.slice(0, 3).map((product) => product.name).join(", ");
    lines.push(
      locale === "fr"
        ? `Produits mis en avant: ${names}.`
        : `Featured products: ${names}.`,
    );
  }

  return lines;
};

const buildRuleBasedReply = ({
  locale,
  message,
  articles,
  supportContext,
}) => {
  const copy = textCopy[locale] || textCopy.en;
  const intent = categorizeIntent(message);
  const normalizedQuestion = normalize(message);
  const scoredArticles = (articles || [])
    .map((article) => ({ article, score: scoreArticle(article, message) }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score);

  if (intent === "greeting") {
    return {
      reply: copy.greeting,
      source: "rules",
      matchedArticles: [],
      needsEscalation: false,
    };
  }

  if (intent === "gratitude") {
    return {
      reply: copy.gratitude,
      source: "rules",
      matchedArticles: [],
      needsEscalation: false,
    };
  }

  if (intent === "capabilities") {
    return {
      reply: copy.capabilities,
      source: "rules",
      matchedArticles: [],
      needsEscalation: false,
    };
  }

  const parts = [];
  const topArticle = scoredArticles[0]?.article;
  const recentOrder = supportContext?.recentOrders?.[0];

  if (topArticle) {
    parts.push(topArticle.answer);
  }

  if (
    /(order|commande|payment|paiement|pending|failed|completed|delivered|livre)/.test(
      normalizedQuestion,
    ) &&
    recentOrder
  ) {
    parts.push(
      locale === "fr"
        ? `Votre commande la plus recente est ${recentOrder._id.toString().slice(-8).toUpperCase()} avec le statut ${recentOrder.status} et le paiement ${recentOrder.paymentStatus}.`
        : `Your most recent order is ${recentOrder._id.toString().slice(-8).toUpperCase()} with status ${recentOrder.status} and payment status ${recentOrder.paymentStatus}.`,
    );
  }

  if (/(loyalty|points|reward|fidelite|tier|niveau)/.test(normalizedQuestion) && supportContext?.loyalty) {
    parts.push(
      locale === "fr"
        ? `Votre solde actuel est ${supportContext.loyalty.points} points et votre niveau est ${supportContext.loyalty.tier}.`
        : `Your current balance is ${supportContext.loyalty.points} points and your tier is ${supportContext.loyalty.tier}.`,
    );
  }

  if (/(product|game|gift card|software|catalog|catalogue|store|boutique)/.test(normalizedQuestion) && supportContext?.featuredProducts?.length) {
    const products = supportContext.featuredProducts
      .slice(0, 3)
      .map((product) => `${product.name}${product.platform ? ` (${product.platform})` : ""}`)
      .join(", ");
    parts.push(
      locale === "fr"
        ? `Parmi les produits en avant en ce moment: ${products}.`
        : `Some featured products right now are: ${products}.`,
    );
  }

  if (!parts.length) {
    parts.push(copy.unknown);
  }

  const needsEscalation = intent === "escalation";
  if (needsEscalation) {
    parts.push(copy.escalate);
  }

  return {
    reply: parts.join(" "),
    source: "rules",
    matchedArticles: scoredArticles.slice(0, 3).map((item) => ({
      slug: item.article.slug,
      title: item.article.title,
      category: item.article.category,
    })),
    needsEscalation,
  };
};

const canUseLlm = () => Boolean(OPENAI_API_KEY);

const buildSystemPrompt = ({ locale, knowledgeArticles, supportContext }) => {
  const contextLines = buildContextLines(locale, supportContext);
  const knowledgeLines = (knowledgeArticles || [])
    .slice(0, 6)
    .map(
      (article, index) =>
        `${index + 1}. [${article.category}] ${article.title}: ${article.summary} ${article.answer}`,
    );

  return [
    locale === "fr"
      ? "Vous etes l'assistant support GamePlug. Repondez en francais clair et bref."
      : "You are the GamePlug support assistant. Reply in clear, concise English.",
    locale === "fr"
      ? "Vous pouvez aider sur les commandes, paiements, produits, recompenses, compte et tickets support."
      : "You can help with orders, payments, products, rewards, accounts, and support tickets.",
    locale === "fr"
      ? "N'inventez rien. Si vous n'etes pas sur, dites-le et recommandez un ticket support."
      : "Do not invent facts. If you are unsure, say so and recommend a support ticket.",
    locale === "fr"
      ? "Ne promettez jamais un remboursement automatique ni une modification de compte."
      : "Never promise an automatic refund or direct account mutation.",
    contextLines.length
      ? `${locale === "fr" ? "Contexte utilisateur:" : "User context:"}\n${contextLines.join("\n")}`
      : "",
    knowledgeLines.length
      ? `${locale === "fr" ? "Base de connaissances:" : "Knowledge base:"}\n${knowledgeLines.join("\n")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");
};

const getLlmReply = async ({ locale, message, history, articles, supportContext }) => {
  const response = await axios.post(
    `${OPENAI_BASE_URL.replace(/\/$/, "")}/chat/completions`,
    {
      model: OPENAI_MODEL,
      temperature: 0.3,
      messages: [
        {
          role: "system",
          content: buildSystemPrompt({
            locale,
            knowledgeArticles: articles,
            supportContext,
          }),
        },
        ...(history || []).slice(-6).map((item) => ({
          role: item.role === "assistant" ? "assistant" : "user",
          content: item.text,
        })),
        { role: "user", content: message },
      ],
    },
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      timeout: 15000,
    },
  );

  return response.data?.choices?.[0]?.message?.content?.trim() || null;
};

const buildSuggestedPrompts = (locale) =>
  locale === "fr"
    ? [
        "Ou est ma commande ?",
        "Comment fonctionne le paiement ?",
        "Comment marchent les points de fidelite ?",
      ]
    : [
        "Where is my order?",
        "How does payment work?",
        "How do loyalty points work?",
      ];

exports.generateSupportAssistantReply = async ({
  locale = "en",
  message,
  history = [],
  articles = [],
  supportContext = null,
}) => {
  const normalizedLocale = locale === "fr" ? "fr" : "en";
  const ruleBased = buildRuleBasedReply({
    locale: normalizedLocale,
    message,
    articles,
    supportContext,
  });

  if (!canUseLlm()) {
    return {
      ...ruleBased,
      suggestedPrompts: buildSuggestedPrompts(normalizedLocale),
    };
  }

  try {
    const llmReply = await getLlmReply({
      locale: normalizedLocale,
      message,
      history,
      articles,
      supportContext,
    });

    if (!llmReply) {
      return {
        ...ruleBased,
        suggestedPrompts: buildSuggestedPrompts(normalizedLocale),
      };
    }

    return {
      reply: llmReply,
      source: "llm",
      matchedArticles: ruleBased.matchedArticles,
      needsEscalation: ruleBased.needsEscalation,
      suggestedPrompts: buildSuggestedPrompts(normalizedLocale),
    };
  } catch (error) {
    return {
      ...ruleBased,
      suggestedPrompts: buildSuggestedPrompts(normalizedLocale),
      modelError: error.message,
    };
  }
};