const axios = require("axios");
const Conversation = require("../Models/conversationModel");
const Order = require("../Models/orderModel");
const Loyalty = require("../Models/loyaltyModel");
const SupportTicket = require("../Models/supportTicketModel");
const Product = require("../Models/productModel");
const SupportKnowledge = require("../Models/supportKnowledgeModel");
const mongoose = require("mongoose");
const db = require("../src/config/db");

// ================== GEMINI CONFIG ==================
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = "gemini-3.5-flash";
const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

if (!GEMINI_API_KEY) {
  console.error("❌ GEMINI_API_KEY missing in .env — get a free key at https://aistudio.google.com/");
}

// ================== SEND MESSAGE ==================
exports.sendMessage = async (req, res) => {
  try {
    const { message, conversationId } = req.body;

    const userId = req.user?.userId || req.user?.id || req.user?._id;

    // ================== VALIDATION ==================
    if (!message || message.trim() === "") {
      return res.status(400).json({
        success: false,
        error: "Message cannot be empty",
      });
    }

    let conversation;

    const connected = db.isConnected ? db.isConnected() : mongoose.connection.readyState === 1;

    // ================== EXISTING CONVERSATION ==================
    if (conversationId && connected) {
      try {
        conversation = await Conversation.findById(conversationId);
      } catch (e) {
        console.warn("DB read failed, proceeding without conversation history:", e.message);
        conversation = null;
      }

      if (!conversation) {
        // Instead of returning 404, create a fresh conversation to continue seamlessly
        console.warn(`Conversation ${conversationId} not found — creating a new conversation.`);
        conversation = new Conversation({ userId: userId || null, messages: [] });
      } else {
        // Ownership check
        if (userId && conversation.userId && conversation.userId.toString() !== userId.toString()) {
          return res.status(403).json({ success: false, error: "Not authorized" });
        }
      }
    }

    if (!conversation) {
      // Create an in-memory conversation object when DB is unavailable
      conversation = new Conversation({ userId: userId || null, messages: [] });
      // If DB not connected, mark as transient
      if (!connected) {
        conversation._transient = true;
      }
    }

    // ================== ESCALATION DETECTION & PROCESSING ==================
    const lowerMessage = message.toLowerCase().trim();
    const escalationKeywords = [
      "escalate", "escalade", "escalader", "support", "admin", "agent", "human", "humain",
      "contact support", "aide humaine", "parler à quelqu'un", "parler a un agent",
      "talk to agent", "representative", "conseiller", "help desk", "service client"
    ];

    const isEscalationRequest = escalationKeywords.some(keyword => lowerMessage.includes(keyword));

    if (isEscalationRequest && connected) {
      const User = require("../Models/userModel");
      
      let userDetails = null;
      if (userId) {
        userDetails = await User.findById(userId).select("username email phonenumber").lean();
      }

      if (userId && userDetails) {
        // Create Support Ticket
        const ticketSubject = `Chatbot Escalation - ${userDetails.username}`;
        
        // Compile prior chat context
        const adminMessages = (conversation.messages || []).map(msg => ({
          sender: msg.role === "assistant" ? "ai" : "customer",
          message: msg.content,
          createdAt: msg.timestamp || new Date()
        }));

        adminMessages.push({
          sender: "customer",
          message: message,
          createdAt: new Date()
        });

        const ticket = await SupportTicket.create({
          userId: userId,
          subject: ticketSubject,
          category: "technical",
          priority: "high",
          status: "open",
          language: "fr",
          source: "web",
          customerMessage: message,
          summary: "Automatic chatbot escalation.",
          metadata: {
            escalatedFromChatbot: true,
            userName: userDetails.username,
            userEmail: userDetails.email,
            userPhone: userDetails.phonenumber || "N/A"
          },
          messages: adminMessages
        });

        // Trigger Notification
        try {
          const { createNotification } = require("./notificationController");
          await createNotification(
            userId,
            "system",
            "Support ticket created",
            `Votre demande d'escalade a été transmise à l'administrateur. Ticket: ${ticket._id.toString().slice(-8).toUpperCase()}`,
            { ticketId: ticket._id, category: ticket.category, status: ticket.status }
          );
        } catch (notiError) {
          console.warn("Notification error:", notiError.message);
        }

        // Add both messages to current chatbot conversation history
        conversation.messages.push({
          role: "user",
          content: message,
          
        });

        const botResponse = `Demande transmise à l'administrateur. Un agent vous contactera par email (${userDetails.email}).`;
        conversation.messages.push({
          role: "assistant",
          content: botResponse,
          timestamp: new Date()
        });

        try {
          if (!conversation._transient) {
            await conversation.save();
          }
        } catch (saveErr) {
          console.warn("Conversation save error:", saveErr.message);
        }

        return res.status(200).json({
          success: true,
          conversationId: conversation._id,
          message: botResponse,
          messages: conversation.messages,
          ticketId: ticket._id
        });
      } else {
        // Not logged in or user not found in DB
        const botResponse = "Pour transmettre votre demande à l'administrateur avec vos coordonnées, veuillez d'abord vous connecter.";
        
        conversation.messages.push({
          role: "user",
          content: message,
          timestamp: new Date()
        });
        
        conversation.messages.push({
          role: "assistant",
          content: botResponse,
          timestamp: new Date()
        });

        try {
          if (!conversation._transient) {
            await conversation.save();
          }
        } catch (saveErr) {
          console.warn("Conversation save error:", saveErr.message);
        }

        return res.status(200).json({
          success: true,
          conversationId: conversation._id,
          message: botResponse,
          messages: conversation.messages
        });
      }
    }

    // ================== SAVE USER MESSAGE ==================
    conversation.messages.push({
      role: "user",
      content: message,
      timestamp: new Date(),
    });

    // ================== BUILD SUPPORT CONTEXT FROM DB ==================
    let supportContext = null;
    try {
      if (userId && connected) {
        const [recentOrders, loyalty, openTicketsCount] = await Promise.all([
          Order.find({ userId }).sort({ createdAt: -1 }).limit(5).lean(),
          Loyalty.findOne({ userId }).lean(),
          SupportTicket.countDocuments({ userId, status: { $ne: "closed" } }),
        ]);

        supportContext = {
          recentOrders: (recentOrders || []).map((o) => ({
            id: o._id,
            totalPrice: o.totalPrice,
            status: o.status,
            paymentStatus: o.paymentStatus,
            createdAt: o.createdAt,
            totalItems: o.totalItems,
          })),
          loyalty: {
            points: loyalty?.points || 0,
            lifetimePoints: loyalty?.lifetimePoints || 0,
            tier: loyalty?.tier || "free",
          },
          openTickets: openTicketsCount || 0,
        };
      }
    } catch (e) {
      console.warn("Failed to build supportContext from DB, continuing without it:", e.message);
      supportContext = null;
    }

    // ================== CALL GROQ API (with support context) ==================
    const aiResponse = await callGeminiAPI(conversation.messages, supportContext);

    // ================== SAVE AI RESPONSE ==================
    conversation.messages.push({
      role: "assistant",
      content: aiResponse,
      timestamp: new Date(),
    });

    // ================== SAVE TO DATABASE (safe)
    try {
      if (!conversation._transient) {
        await conversation.save();
      } else {
        console.log("DB is down — skipping conversation.save() (transient conversation)");
      }
    } catch (e) {
      console.warn("Failed to save conversation (continuing without save):", e.message);
    }

    // ================== SUCCESS RESPONSE ==================
    return res.status(200).json({
      success: true,
      conversationId: conversation._id,
      message: aiResponse,
      messages: conversation.messages,
    });

  } catch (error) {
    console.log("❌ FULL ERROR:");
    console.log(error);

    console.log("❌ ERROR MESSAGE:");
    console.log(error.message);

    console.log("❌ ERROR RESPONSE:");
    console.log(error.response?.data);

    return res.status(500).json({
      success: false,
      error: error.message,
      details: error.response?.data || null,
    });
  }
};

// ================== GET SINGLE CONVERSATION ==================
exports.getConversation = async (req, res) => {
  try {
    const { conversationId } = req.params;

    const userId = req.user?.userId || req.user?.id || req.user?._id;

    const conversation = await Conversation.findById(conversationId);

    if (!conversation) {
      return res.status(404).json({
        success: false,
        error: "Conversation not found",
      });
    }

    // Ownership check
    if (
      userId &&
      conversation.userId &&
      conversation.userId.toString() !== userId.toString()
    ) {
      return res.status(403).json({
        success: false,
        error: "Not authorized",
      });
    }

    return res.status(200).json({
      success: true,
      conversation,
    });

  } catch (error) {
    console.error("❌ getConversation error:", error);

    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
};

// ================== GET ALL CONVERSATIONS ==================
exports.getConversations = async (req, res) => {
  try {
    const userId = req.user?.userId || req.user?.id || req.user?._id;

    if (!userId) {
      return res.status(401).json({
        success: false,
        error: "Not authenticated",
      });
    }

    const conversations = await Conversation.find({ userId })
      .select("-messages")
      .sort({ createdAt: -1 });

    return res.status(200).json({
      success: true,
      conversations,
    });

  } catch (error) {
    console.error("❌ getConversations error:", error);

    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
};

// ================== DELETE CONVERSATION ==================
exports.deleteConversation = async (req, res) => {
  try {
    const { conversationId } = req.params;

    const userId = req.user?.userId || req.user?.id || req.user?._id;

    const conversation = await Conversation.findById(conversationId);

    if (!conversation) {
      return res.status(404).json({
        success: false,
        error: "Conversation not found",
      });
    }

    // Ownership check
    if (
      userId &&
      conversation.userId &&
      conversation.userId.toString() !== userId.toString()
    ) {
      return res.status(403).json({
        success: false,
        error: "Not authorized",
      });
    }

    await Conversation.findByIdAndDelete(conversationId);

    return res.status(200).json({
      success: true,
      message: "Conversation deleted",
    });

  } catch (error) {
    console.error("❌ deleteConversation error:", error);

    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
};

// ================== CLEAR CONVERSATION ==================
exports.clearConversation = async (req, res) => {
  try {
    const { conversationId } = req.params;

    const userId = req.user?.userId || req.user?.id || req.user?._id;

    const conversation = await Conversation.findById(conversationId);

    if (!conversation) {
      return res.status(404).json({
        success: false,
        error: "Conversation not found",
      });
    }

    // Ownership check
    if (
      userId &&
      conversation.userId &&
      conversation.userId.toString() !== userId.toString()
    ) {
      return res.status(403).json({
        success: false,
        error: "Not authorized",
      });
    }

    conversation.messages = [];

    await conversation.save();

    return res.status(200).json({
      success: true,
      message: "Conversation cleared",
    });

  } catch (error) {
    console.error("❌ clearConversation error:", error);

    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
};

// ================== GEMINI HELPER ==================
async function callGeminiAPI(conversationHistory, supportContext) {
  try {
    if (!GEMINI_API_KEY) {
      throw new Error("Missing GEMINI_API_KEY");
    }

    const systemPrompt = `You are GamePlug AI Support Assistant — a friendly, knowledgeable assistant for an online gaming store.

You help users with:
- Order status and tracking
- Payment methods (Flouci and others)
- Loyalty points and rewards system
- Refunds and cancellations
- Product recommendations
- Account and technical issues

You have direct access to our real-time database catalog and support knowledge base, which are dynamically injected into your context. Use this data (prices, stock, platforms, FAQs) to answer user questions precisely. If a product is out of stock (Stock: 0), let the user know. If details are not found in the context, help them based on general store knowledge or politely ask for clarification.

Always be concise, friendly and professional. Answer in the same language the user writes in (French, English or Tunisian Arabic/Derja).`;

    const connected = db.isConnected ? db.isConnected() : mongoose.connection.readyState === 1;

    // Build support context summary
    let contextNote = "";
    if (supportContext) {
      const ordersSummary = supportContext.recentOrders?.length
        ? `Recent orders: ${supportContext.recentOrders.map(o => `${o.status} (${o.totalPrice} TND)`).slice(0, 3).join(", ")}.`
        : "No recent orders.";
      const loyaltySummary = `Loyalty: ${supportContext.loyalty.points} points (tier: ${supportContext.loyalty.tier}).`;
      const ticketsSummary = `Open support tickets: ${supportContext.openTickets}.`;
      contextNote = `\n\n[User context: ${ordersSummary} ${loyaltySummary} ${ticketsSummary}]`;
    }

    // Build conversation turns for Gemini (skip last user msg — it's the current one)
    const history = conversationHistory.slice(-10);
    const lastMsg = history[history.length - 1];

    // Build database catalog and FAQ context dynamically matching the user query
    let dbContextNote = "";
    if (connected && lastMsg?.content) {
      try {
        const queryText = lastMsg.content;
        
        // Clean words for searching (split by space, strip punctuation, filter out small words)
        const words = queryText
          .toLowerCase()
          .replace(/[.,\/#!$%\^&\*;:{}=\-_`~()?]/g, "")
          .split(/\s+/)
          .filter(w => w.length > 2);
          
        if (words.length > 0) {
          // 1. Search products
          const productOrConditions = words.map(word => ({
            $or: [
              { name: { $regex: word, $options: "i" } },
              { description: { $regex: word, $options: "i" } },
              { category: { $regex: word, $options: "i" } },
              { platform: { $regex: word, $options: "i" } },
              { genre: { $regex: word, $options: "i" } }
            ]
          }));
          
          const dbProducts = await Product.find({ $or: productOrConditions }).limit(6).lean();
          
          if (dbProducts && dbProducts.length > 0) {
            dbContextNote += "\n\nAvailable Products in Store matching query:\n" + dbProducts.map(p => 
              `- ${p.name} | Price: ${p.price} TND | Stock: ${p.stock} | Category: ${p.category} | Platform: ${p.platform || "N/A"} | Genre: ${p.genre || "N/A"}`
            ).join("\n");
          }
          
          // 2. Search FAQs/Knowledge base
          const faqOrConditions = words.map(word => ({
            $or: [
              { category: { $regex: word, $options: "i" } },
              { tags: { $regex: word, $options: "i" } },
              { "translations.title": { $regex: word, $options: "i" } },
              { "translations.question": { $regex: word, $options: "i" } },
              { "translations.answer": { $regex: word, $options: "i" } }
            ]
          }));
          
          const dbFAQs = await SupportKnowledge.find({ $or: faqOrConditions }).limit(4).lean();
          
          if (dbFAQs && dbFAQs.length > 0) {
            dbContextNote += "\n\nRelevant Support FAQs:\n" + dbFAQs.map(f => {
              const trans = f.translations?.find(t => t.locale === "fr") || f.translations?.[0] || {};
              return `- Question: ${trans.question || trans.title}\n  Answer: ${trans.answer}`;
            }).join("\n");
          }
        }
      } catch (err) {
        console.warn("Failed to retrieve database context for Gemini:", err.message);
      }
    }

    // Gemini uses 'contents' array with role: 'user' | 'model'
    const contents = history.slice(0, -1).map(msg => ({
      role: msg.role === "assistant" ? "model" : "user",
      parts: [{ text: msg.content }],
    }));

    // Add current user message
    contents.push({
      role: "user",
      parts: [{ text: lastMsg.content }],
    });

    console.log("🚀 Sending request to Gemini API");

    const response = await axios.post(
      `${GEMINI_API_URL}?key=${GEMINI_API_KEY}`,
      {
        system_instruction: {
          parts: [{ text: systemPrompt + contextNote + dbContextNote }],
        },
        contents,
        generationConfig: {
          temperature: 0.7,
          maxOutputTokens: 1024,
        },
      },
      {
        headers: { "Content-Type": "application/json" },
        timeout: 30000,
      }
    );

    console.log("✅ Gemini success");

    return (
      response.data?.candidates?.[0]?.content?.parts?.[0]?.text ||
      "No response generated."
    );

  } catch (error) {
    console.error("❌ GEMINI API ERROR:", {
      message: error.message,
      status: error.response?.status,
      data: error.response?.data,
    });

    const lastUser = conversationHistory?.length
      ? conversationHistory[conversationHistory.length - 1].content
      : "";
    const fallback = generateFallbackResponse(lastUser);
    console.warn("Using fallback response due to Gemini failure.");
    return fallback;
  }
}

function generateFallbackResponse(userMessage) {
  if (!userMessage) return "Bonjour — je suis l'assistant GamePlug. Comment puis-je vous aider ?";
  const m = userMessage.toLowerCase();
  if (m.includes('bonjour') || m.includes('salut') || m.includes('hello')) return 'Bonjour! Je suis l\'assistant GamePlug. Comment puis-je vous aider aujourd\'hui?';
  if (m.includes('commande') || m.includes('order')) return 'Pour passer une commande, ajoutez des produits au panier puis procédez au paiement. Besoin d\'aide pour une commande existante?';
  if (m.includes('paiement') || m.includes('payment')) return 'Nous acceptons cartes de crédit et portefeuilles numériques. Votre paiement est sécurisé.';
  if (m.includes('fidélité') || m.includes('loyalty') || m.includes('points')) return 'Le programme de fidélité vous fait gagner des points à chaque achat. Vous pouvez les convertir en réductions.';
  if (m.includes('produit') || m.includes('product')) return 'Nous avons plusieurs catégories de produits. Quelle catégorie vous intéresse?';
  if (m.includes('support') || m.includes('probleme') || m.includes('issue')) return 'Décrivez votre problème et notre équipe de support vous aidera rapidement.';
  return "Désolé, je n'ai pas accès au service IA en ce moment — mais je peux vous aider. Pouvez-vous préciser votre demande ?";
}