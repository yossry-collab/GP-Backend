module.exports = [
  {
    slug: "instant-digital-delivery",
    category: "delivery",
    tags: ["delivery", "digital", "keys", "timing"],
    sortOrder: 10,
    translations: [
      {
        locale: "en",
        title: "Instant digital delivery",
        question: "How fast do I receive my order after payment?",
        summary: "Most digital orders are fulfilled right after successful payment confirmation.",
        answer:
          "GamePlug focuses on digital products. Most paid orders are delivered shortly after payment confirmation. If your order stays pending or you do not receive your item, the assistant should check your order status first and then offer to create a support ticket for manual follow-up.",
      },
      {
        locale: "fr",
        title: "Livraison digitale instantanee",
        question: "En combien de temps je recois ma commande apres le paiement ?",
        summary: "La plupart des commandes digitales sont traitees juste apres la confirmation du paiement.",
        answer:
          "GamePlug se concentre sur les produits digitaux. La plupart des commandes payees sont livrees peu apres la confirmation du paiement. Si une commande reste en attente ou si le produit n'arrive pas, l'assistant doit verifier le statut de la commande puis proposer la creation d'un ticket de support.",
      },
    ],
  },
  {
    slug: "payment-method-flouci",
    category: "payments",
    tags: ["payment", "flouci", "checkout"],
    sortOrder: 20,
    translations: [
      {
        locale: "en",
        title: "Flouci payment flow",
        question: "How does payment work on GamePlug?",
        summary: "Checkout currently routes users through Flouci for secure payment confirmation.",
        answer:
          "GamePlug currently uses Flouci for checkout. Customers review their cart, continue to the payment page, and are redirected to a secure Flouci session. If a payment succeeds, the order can move to a paid or completed state. If a customer reports a payment issue, the assistant should check the order and payment status and escalate with a support ticket when needed.",
      },
      {
        locale: "fr",
        title: "Paiement avec Flouci",
        question: "Comment fonctionne le paiement sur GamePlug ?",
        summary: "Le paiement passe actuellement par Flouci pour confirmer la transaction en toute securite.",
        answer:
          "GamePlug utilise actuellement Flouci pour le paiement. Le client verifie son panier, continue vers la page de paiement, puis est redirige vers une session Flouci securisee. Si le paiement reussit, la commande peut passer a l'etat paye ou complete. En cas de probleme de paiement, l'assistant doit verifier le statut de la commande et du paiement puis proposer un ticket de support si necessaire.",
      },
    ],
  },
  {
    slug: "order-status-meaning",
    category: "orders",
    tags: ["order", "status", "pending", "completed", "failed"],
    sortOrder: 30,
    translations: [
      {
        locale: "en",
        title: "Order status guide",
        question: "What do pending, completed, and failed order statuses mean?",
        summary: "Pending means still processing, completed means approved or fulfilled, and failed means the order did not complete.",
        answer:
          "A pending order is still being processed. A completed order means the order has been approved or fulfilled. A failed order means the order did not finish successfully. Payment status is tracked separately, so support answers should check both the order status and the payment status before giving a final response.",
      },
      {
        locale: "fr",
        title: "Guide des statuts de commande",
        question: "Que signifient les statuts pending, completed et failed ?",
        summary: "Pending signifie en cours de traitement, completed signifie approuvee ou livree, et failed signifie echec.",
        answer:
          "Une commande pending est encore en cours de traitement. Une commande completed signifie que la commande a ete approuvee ou livree. Une commande failed signifie que la commande n'a pas abouti. Le statut du paiement est suivi separement, donc les reponses du support doivent verifier a la fois le statut de la commande et celui du paiement.",
      },
    ],
  },
  {
    slug: "refund-and-key-issues",
    category: "refunds",
    tags: ["refund", "key", "issue", "support"],
    sortOrder: 40,
    translations: [
      {
        locale: "en",
        title: "Refund and key issue guidance",
        question: "What should I do if my key does not work or I want a refund?",
        summary: "Refunds and key issues should be escalated to human support for review.",
        answer:
          "If a customer reports a non-working key or asks for a refund, the assistant should gather the order context and create a support ticket for human review. The first release should not promise automatic refunds or direct account changes. It should explain that payment and order details will be reviewed by support before a final resolution is provided.",
      },
      {
        locale: "fr",
        title: "Remboursement et probleme de cle",
        question: "Que faire si ma cle ne fonctionne pas ou si je veux un remboursement ?",
        summary: "Les demandes de remboursement et les problemes de cle doivent etre escalades vers le support humain.",
        answer:
          "Si un client signale une cle invalide ou demande un remboursement, l'assistant doit recuperer le contexte de la commande puis creer un ticket de support pour une verification humaine. La premiere version ne doit pas promettre un remboursement automatique ni effectuer de changement de compte. Elle doit expliquer que les details du paiement et de la commande seront verifies avant une resolution finale.",
      },
    ],
  },
  {
    slug: "loyalty-points-and-tiers",
    category: "loyalty",
    tags: ["loyalty", "points", "tier", "rewards"],
    sortOrder: 50,
    translations: [
      {
        locale: "en",
        title: "Loyalty points and tiers",
        question: "How do GamePlug loyalty points and tiers work?",
        summary: "Users can earn points, unlock tiers, and redeem rewards inside the loyalty system.",
        answer:
          "GamePlug tracks loyalty balances, lifetime points, streaks, tiers, rewards, quests, packs, and memberships. A support assistant can answer general questions about these systems and, for logged-in users, it can also read the user-specific loyalty balance and tier status from the backend before responding.",
      },
      {
        locale: "fr",
        title: "Points et niveaux de fidelite",
        question: "Comment fonctionnent les points et les niveaux GamePlug ?",
        summary: "Les utilisateurs peuvent gagner des points, debloquer des niveaux et echanger des recompenses.",
        answer:
          "GamePlug suit le solde de fidelite, les points a vie, les series de connexion, les niveaux, les recompenses, les quetes, les packs et les abonnements. L'assistant peut repondre aux questions generales sur ces systemes et, pour les utilisateurs connectes, il peut aussi consulter le solde et le niveau actuels avant de repondre.",
      },
    ],
  },
  {
    slug: "account-and-security-help",
    category: "account",
    tags: ["account", "profile", "login", "security"],
    sortOrder: 60,
    translations: [
      {
        locale: "en",
        title: "Account and profile help",
        question: "Can I update my GamePlug account details?",
        summary: "Users can update their profile information from the account area.",
        answer:
          "Logged-in customers can update their profile information from the profile area. If they need help with account access, profile edits, or password changes, the assistant can explain the available path in the app and create a support ticket if the issue cannot be completed normally.",
      },
      {
        locale: "fr",
        title: "Aide sur le compte et le profil",
        question: "Puis-je mettre a jour les informations de mon compte GamePlug ?",
        summary: "Les utilisateurs peuvent modifier leur profil depuis l'espace compte.",
        answer:
          "Les clients connectes peuvent modifier les informations de leur profil depuis la page profil. Si un utilisateur a besoin d'aide pour l'acces au compte, les modifications du profil ou le mot de passe, l'assistant peut expliquer le parcours disponible dans l'application puis proposer un ticket si le probleme ne peut pas etre resolu normalement.",
      },
    ],
  },
  {
    slug: "product-help-and-availability",
    category: "products",
    tags: ["products", "catalog", "availability", "pricing"],
    sortOrder: 70,
    translations: [
      {
        locale: "en",
        title: "Product and catalog help",
        question: "What kinds of products does GamePlug sell?",
        summary: "The store catalog currently includes games, software, and gift cards.",
        answer:
          "GamePlug currently organizes its catalog around games, software, and gift cards. Product records may also include details such as price, stock, publisher, genre, platform, release date, discount percentage, and whether the product is featured. The assistant should use live product data for availability and pricing instead of relying only on static copy.",
      },
      {
        locale: "fr",
        title: "Aide sur le catalogue produit",
        question: "Quels types de produits sont vendus sur GamePlug ?",
        summary: "Le catalogue contient actuellement des jeux, des logiciels et des cartes cadeaux.",
        answer:
          "GamePlug organise actuellement son catalogue autour des jeux, des logiciels et des cartes cadeaux. Les fiches produit peuvent aussi inclure le prix, le stock, l'editeur, le genre, la plateforme, la date de sortie, le pourcentage de remise et le statut mis en avant. L'assistant doit utiliser les donnees produit en direct pour le prix et la disponibilite.",
      },
    ],
  },
  {
    slug: "human-support-escalation",
    category: "general",
    tags: ["support", "ticket", "agent", "help"],
    sortOrder: 80,
    translations: [
      {
        locale: "en",
        title: "How human support escalation works",
        question: "Can I talk to support if the assistant cannot solve my issue?",
        summary: "Yes. The assistant can create a support ticket for human follow-up.",
        answer:
          "If the assistant cannot solve a problem confidently, it should offer to create a support ticket for a human follow-up. Ticket creation is the correct path for payment problems, refund-related issues, invalid keys, account anomalies, or any case that requires manual review.",
      },
      {
        locale: "fr",
        title: "Escalade vers le support humain",
        question: "Puis-je parler au support si l'assistant ne resout pas mon probleme ?",
        summary: "Oui. L'assistant peut creer un ticket pour un suivi humain.",
        answer:
          "Si l'assistant ne peut pas resoudre un probleme avec confiance, il doit proposer la creation d'un ticket pour un suivi humain. C'est le bon parcours pour les problemes de paiement, les demandes liees au remboursement, les cles invalides, les anomalies de compte ou tout cas qui demande une verification manuelle.",
      },
    ],
  },
];