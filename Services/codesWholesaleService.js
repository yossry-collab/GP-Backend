/**
 * CodesWholesale API Service
 * 
 * Handles OAuth 2.0 authentication and all API interactions
 * with the CodesWholesale platform (sandbox or live).
 * 
 * Docs: https://api.codeswholesale.com
 */

const axios = require("axios");

class CodesWholesaleService {
  constructor() {
    this.accessToken = null;
    this.tokenExpiresAt = null;
  }

  get baseUrl() {
    return process.env.CW_API_URL || "https://sandbox.codeswholesale.com";
  }

  get clientId() {
    return process.env.CW_CLIENT_ID;
  }

  get clientSecret() {
    return process.env.CW_CLIENT_SECRET;
  }

  // ─── OAuth 2.0 Token Management ──────────────────────────────────

  /**
   * Get a valid access token, refreshing if expired
   */
  async getToken() {
    // Return cached token if still valid (with 60s buffer)
    if (this.accessToken && this.tokenExpiresAt && Date.now() < this.tokenExpiresAt - 60000) {
      return this.accessToken;
    }

    try {
      const response = await axios.post(
        `${this.baseUrl}/oauth/token`,
        `grant_type=client_credentials&client_id=${encodeURIComponent(this.clientId)}&client_secret=${encodeURIComponent(this.clientSecret)}`,
        {
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
          },
        }
      );

      this.accessToken = response.data.access_token;
      this.tokenExpiresAt = Date.now() + response.data.expires_in * 1000;

      console.log("✅ CodesWholesale token obtained, expires in", response.data.expires_in, "seconds");
      return this.accessToken;
    } catch (error) {
      console.error("❌ CodesWholesale auth error:", error.response?.data || error.message);
      throw new Error("Failed to authenticate with CodesWholesale API");
    }
  }

  /**
   * Make an authenticated GET request to the CW API
   */
  async apiGet(endpoint) {
    const token = await this.getToken();
    try {
      const response = await axios.get(`${this.baseUrl}${endpoint}`, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
        },
      });
      return response.data;
    } catch (error) {
      // If 401, try refreshing token once
      if (error.response?.status === 401) {
        this.accessToken = null;
        const newToken = await this.getToken();
        const retry = await axios.get(`${this.baseUrl}${endpoint}`, {
          headers: {
            Authorization: `Bearer ${newToken}`,
            Accept: "application/json",
          },
        });
        return retry.data;
      }
      console.error(`❌ CW API GET ${endpoint} error:`, error.response?.data || error.message);
      throw error;
    }
  }

  // ─── Products ────────────────────────────────────────────────────

  /**
   * Fetch all products from the CodesWholesale price list
   */
  async getProducts() {
    const data = await this.apiGet("/v3/products");
    return data;
  }

  /**
   * Fetch a single product by its CodesWholesale ID
   */
  async getProductById(productId) {
    const data = await this.apiGet(`/v3/products/${productId}`);
    return data;
  }

  /**
   * Fetch product description by product ID
   */
  async getProductDescription(productId) {
    try {
      const data = await this.apiGet(`/v3/products/${productId}/description`);
      return data;
    } catch (error) {
      // Some products may not have descriptions
      return null;
    }
  }

  // ─── Product Images ──────────────────────────────────────────────

  /**
   * Fetch product image by product ID
   */
  async getProductImage(productId) {
    try {
      const data = await this.apiGet(`/v3/productImages/${productId}`);
      return data;
    } catch (error) {
      // Some products may not have images
      return null;
    }
  }

  // ─── Platforms & Regions ─────────────────────────────────────────

  /**
   * Fetch all available platforms (Steam, Origin, PSN, Xbox, etc.)
   */
  async getPlatforms() {
    const data = await this.apiGet("/v3/platforms");
    return data;
  }

  /**
   * Fetch all available regions
   */
  async getRegions() {
    const data = await this.apiGet("/v3/regions");
    return data;
  }

  /**
   * Fetch all available territories
   */
  async getTerritories() {
    const data = await this.apiGet("/v3/territory");
    return data;
  }

  /**
   * Fetch all available languages
   */
  async getLanguages() {
    const data = await this.apiGet("/v3/languages");
    return data;
  }

  // ─── Account ─────────────────────────────────────────────────────

  /**
   * Get current account details (balance, info, etc.)
   */
  async getAccountDetails() {
    const data = await this.apiGet("/v3/accounts/current");
    return data;
  }

  // ─── Helpers ─────────────────────────────────────────────────────

  /**
   * Known Steam App IDs for popular games (used for image fallback)
   */
  static STEAM_APP_IDS = {
    "act of aggression": 318020,
    "anomaly korea": 251530,
    "chivalry : medieval warfare": 219640,
    "chroma squad": 251130,
    "cities in motion 2": 225420,
    "civilization 6": 289070,
    "commandos: behind enemy lines": 6800,
    "darksiders": 50620,
    "dead age": 363930,
    "duke nukem 3d: 20th anniversary world tour": 434050,
    "duke nukem forever": 57900,
    "enclave": 253980,
    "fallen enchantress: legendary heroes": 228260,
    "hard reset redux": 407810,
    "hitman: codename 47": 6900,
    "lego: batman 2 - dc super heroes": 213330,
    "lego: batman 3 - beyond gotham": 313690,
    "lego: harry potter years 1-4": 21130,
    "lego: lord of the rings": 214510,
    "lego: marvel super heroes": 249130,
    "lost planet 3": 226720,
    "orcs must die! 2": 201790,
    "quake champions": 611500,
    "quake ii": 2320,
    "rebel galaxy": 290300,
    "red faction: guerrilla re-mars-tered": 667720,
    "sniper elite: nazi zombie army": 227100,
    "total war: rome 2": 214950,
    "worms blast": 70650,
    "worms crazy golf": 70620,
    "beholder 2": 761620,
    "broken age": 232790,
    "book of demons": 449960,
    "gloria victis": 327070,
    "guacamelee! super turbo championship": 275390,
    "kholat": 343710,
    "men of war: assault squad": 64000,
    "silence": 314790,
    "stronghold hd": 40950,
    "mass effect 2": 24980,
    "wrc 5": 354160,
    "tropico 5: espionage": 284441,
    "12 is better than 6": 410110,
    "no time to explain remastered": 368730,
    "railway empire": 503940,
    "from dust": 33460,
  };

  /**
   * Get a Steam header image URL for a game name
   */
  static getSteamImage(gameName) {
    const lower = (gameName || "").toLowerCase();
    for (const [key, appId] of Object.entries(CodesWholesaleService.STEAM_APP_IDS)) {
      if (lower.includes(key) || key.includes(lower)) {
        return `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${appId}/header.jpg`;
      }
    }
    return null;
  }

  /**
   * Map a CW product to our internal product format
   */
  mapToLocalProduct(cwProduct) {
    // Determine category based on product platform or name
    let category = "game"; // default
    const name = (cwProduct.name || "").toLowerCase();
    const platform = (cwProduct.platform || "").toLowerCase();

    if (
      name.includes("windows") ||
      name.includes("office") ||
      platform === "none"
    ) {
      category = "software";
    } else if (
      name.includes("gift card") ||
      name.includes("cash card") ||
      name.includes("fut points") ||
      name.includes("v-bucks") ||
      name.includes("membership") ||
      name.includes("psn card") ||
      name.includes("points")
    ) {
      category = "gift-card";
    }

    // Try to get a real image
    let imageUrl = "";

    // 1. Check if CW provided a real image (not the placeholder)
    const cwImages = cwProduct.images || [];
    const mediumImg = cwImages.find((i) => i.format === "MEDIUM");
    const smallImg = cwImages.find((i) => i.format === "SMALL");
    const cwImg = mediumImg?.image || smallImg?.image || "";

    if (cwImg && !cwImg.includes("no-image")) {
      imageUrl = cwImg;
    }

    // 2. Fallback: try Steam CDN
    if (!imageUrl && (platform === "steam" || platform === "Steam")) {
      imageUrl = CodesWholesaleService.getSteamImage(cwProduct.name) || "";
    }

    // 3. Fallback: use a themed placeholder from Unsplash
    if (!imageUrl) {
      if (category === "software") {
        imageUrl = "https://images.unsplash.com/photo-1629654297299-c8506221ca97?w=460&h=215&fit=crop";
      } else if (category === "gift-card") {
        imageUrl = "https://images.unsplash.com/photo-1556742049-0cfed4f6a45d?w=460&h=215&fit=crop";
      } else {
        imageUrl = "https://images.unsplash.com/photo-1538481199705-c710c4e965fc?w=460&h=215&fit=crop";
      }
    }

    // Extract price (prices array has volume-based pricing, use first tier)
    const price = cwProduct.prices?.[0]?.value || 0;

    return {
      name: cwProduct.name || "Unknown Product",
      description: `${cwProduct.name} - ${cwProduct.platform || "Digital"} key. ${cwProduct.regions ? "Region: " + (Array.isArray(cwProduct.regions) ? cwProduct.regions.join(", ") : cwProduct.regions) : ""}`.trim(),
      price,
      category,
      image: imageUrl,
      stock: cwProduct.quantity != null ? cwProduct.quantity : 0,
      cwProductId: cwProduct.productId || cwProduct.id || null,
      platform: cwProduct.platform || null,
      region: cwProduct.regions || null,
    };
  }
}

// Singleton instance
const cwService = new CodesWholesaleService();
module.exports = cwService;
