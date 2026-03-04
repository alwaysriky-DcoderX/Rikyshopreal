const express = require("express");
const qs = require("qs");
const multer = require('multer');
const cloudscraper = require("cloudscraper");
const axios = require("axios");
const upload = multer();
const app = express();
const router = express.Router();
app.use(express.urlencoded({
  extended: true
}));
app.use(express.json());

const domain = process.env.PTERO_DOMAIN;
const apikey = process.env.PTERO_API_KEY;

const {
  requireLogin,
  User,
  tambahHistoryDeposit,
  generateReffId,
  BASE_URL,
  ATLAN_API_KEY,
  editHistoryDeposit,
  tambahHistoryOrder,
  editHistoryOrder,
} = require("../index.js");

const cloudscraperHeaders = {
  "Content-Type": "application/x-www-form-urlencoded",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36",
};

const PAYDIGITAL_BASE_URL = process.env.PAYDIGITAL_BASE_URL || "https://paydigital.biz.id";
const PAYDIGITAL_API_KEY = process.env.PAYDIGITAL_API_KEY;
const PAYDIGITAL_DEFAULT_SERVER = parseInt(process.env.PAYDIGITAL_DEFAULT_SERVER || "1");
const PAYDIGITAL_DEFAULT_QRISTYPE = process.env.PAYDIGITAL_DEFAULT_QRISTYPE || "1";

async function payDigitalRequest(config) {
  if (!PAYDIGITAL_API_KEY) {
    const err = new Error("PAYDIGITAL_API_KEY belum di-set");
    err.statusCode = 500;
    throw err;
  }
  const resp = await axios({
    timeout: 30000,
    baseURL: PAYDIGITAL_BASE_URL,
    headers: {
      "x-api-key": PAYDIGITAL_API_KEY,
      ...(config.headers || {}),
    },
    ...config,
  });
  return resp.data;
}

async function getPayDigitalChannels({ server, qristype } = {}) {
  const params = {};
  if (server) params.server = server;
  if (qristype) params.qristype = qristype;
  const data = await payDigitalRequest({
    method: "GET",
    url: "/api/payment-channels",
    params,
  });
  if (!data?.ok || !Array.isArray(data?.data)) {
    throw new Error(data?.error || "Gagal mengambil payment channels PayDigital");
  }
  return data;
}

function parsePayDigitalMetode(metode) {
  if (!metode || typeof metode !== "string") {
    return { server: PAYDIGITAL_DEFAULT_SERVER, qristype: PAYDIGITAL_DEFAULT_QRISTYPE };
  }
  // format: "PAYDIGITAL:server:qristype" atau "server:qristype"
  const normalized = metode.startsWith("PAYDIGITAL:") ? metode.replace("PAYDIGITAL:", "") : metode;
  const parts = normalized.split(":");
  if (parts.length >= 2 && parts[0] && parts[1]) {
    const s = parseInt(parts[0]);
    return {
      server: Number.isFinite(s) ? s : PAYDIGITAL_DEFAULT_SERVER,
      qristype: parts[1] || PAYDIGITAL_DEFAULT_QRISTYPE,
    };
  }
  return { server: PAYDIGITAL_DEFAULT_SERVER, qristype: PAYDIGITAL_DEFAULT_QRISTYPE };
}

router.post("/deposit/metode", requireLogin, async (req, res) => {
  try {
    const role = req.session.role || "user";
    let tambahanPersen = 0;
    if (role === "user") tambahanPersen = 0.2;
    if (role === "reseller") tambahanPersen = 0.1;

    const channelsResp = await getPayDigitalChannels();
    const channels = channelsResp.data;
    const fullUrl = `${req.protocol}://${req.get("host")}`;

    const isChannelActive = (ch) => {
      if (typeof ch?.active === "boolean") return ch.active;
      if (typeof ch?.status === "boolean") return ch.status;
      if (typeof ch?.status === "string") return ch.status.toLowerCase() === "active";
      return true;
    };

    const activeChannels = Array.isArray(channels) ? channels.filter(isChannelActive) : [];
    const channelsToUse = activeChannels.length > 0 ? activeChannels : channels;

    const metodeFormatted = (channelsToUse || [])
      .map((ch) => {
        const feePersen = (0 + tambahanPersen).toFixed(2);
        return {
          metode: `PAYDIGITAL:${ch.server}:${ch.qristype}`,
          type: "qris",
          name: `${ch.name || `Server ${ch.server}`} (${ch.code || "QRIS"})`,
          min: 1000,
          max: 100000000,
          fee: 250,
          fee_persen: feePersen,
          status: ch.status,
          img_url: `${fullUrl}/media/metode/qrisfast.png`,
        };
      });
    return res.status(200).json({
      success: true,
      message: "Daftar metode deposit berhasil difilter",
      metode: metodeFormatted,
    });
  } catch (error) {
    const providerError = error?.response?.data || null;
    console.error("[DEPOSIT/METODE] gagal ambil metode:", providerError || error.message);
    res.status(500).json({
      success: false,
      message: providerError?.error || providerError?.message || error.message || "Gagal mengambil metode deposit",
      error: providerError || error.message,
    });
  }
});

router.post("/deposit/create", requireLogin, async (req, res) => {
  console.log("🔔 [DEPOSIT] Endpoint /deposit/create dipanggil");
  const user = await User.findById(req.session.userId);
  if (!user) {
    console.log("🚫 User tidak ditemukan atau sesi tidak valid. ID Session:", req.session.userId);
    return res.status(401).json({
      success: false,
      message: "User tidak ditemukan atau sesi tidak valid."
    });
  }
  const {
    nominal,
    metode: metodePilihanPengguna
  } = req.body;
  console.log(`📥 Permintaan deposit oleh ${user.username || user.email || user._id}`);
  console.log("🧾 Data diterima:", {
    nominal,
    metode: metodePilihanPengguna
  });
  if (!nominal || isNaN(nominal)) {
    console.log("❗ Nominal tidak valid:", nominal);
    return res.status(400).json({
      success: false,
      message: "Nominal harus diisi dan berupa angka.",
    });
  }
  const parsedNominal = parseInt(nominal);

  const minDepositForMetode = 500;
  if (parsedNominal < minDepositForMetode) {
    return res.status(400).json({
      success: false,
      message: `Nominal minimal deposit adalah ${minDepositForMetode}. Nominal Anda: ${parsedNominal}.`,
    });
  }

  const { server, qristype } = parsePayDigitalMetode(metodePilihanPengguna);
  const note = `Deposit ${user.username || user.email || user._id}`;
  try {

    const createResp = await payDigitalRequest({
      method: "POST",
      url: "/createqris",
      headers: {
        "Content-Type": "application/json",
      },
      data: {
        amount: parsedNominal,
        note,
        server,
        qristype,
      },
    });

    if (!createResp?.ok || !createResp?.tx) {
      return res.status(502).json({
        success: false,
        message: createResp?.error || "Gagal membuat QRIS PayDigital.",
        error: createResp,
      });
    }

    const tx = createResp.tx;
    const payment = createResp.payment || {};

    const originalFee = parseInt(tx.fee) || 250;
    const originalGetBalance = parsedNominal;
    let additionalFee = 0;
    if (user.role === "user") {
      additionalFee = Math.ceil(originalGetBalance * 0.002);
    } else if (user.role === "reseller") {
      additionalFee = Math.ceil(originalGetBalance * 0.001);
    }
    const totalFee = originalFee + additionalFee;
    const finalBalance = originalGetBalance - additionalFee;
    const historyDataForDb = {
      id: tx.id,
      reff_id: tx.ref_id,
      nominal: parsedNominal,
      tambahan: 0,
      fee: totalFee,
      get_balance: finalBalance,
      metode: `PAYDIGITAL:${server}:${qristype}`,
      bank: null,
      tujuan: tx.pay_url || null,
      atas_nama: null,
      status: "pending",
      qr_image: payment.qr_link || null,
      created_at: tx.createdAt ? new Date(tx.createdAt) : new Date(),
    };
    await tambahHistoryDeposit(user._id, historyDataForDb);
    res.status(200).json({
      success: true,
      data: {
        id: tx.id,
        reff_id: tx.ref_id,
        nominal: parsedNominal,
        fee: totalFee,
        get_balance: finalBalance,
        metode: historyDataForDb.metode,
        status: historyDataForDb.status,
        qr_image: historyDataForDb.qr_image,
        pay_url: tx.pay_url,
        expired_at: tx.expiredAt,
      },
    });
    const intervalId = setInterval(async () => {
      try {
        const statusResp = await payDigitalRequest({
          method: "GET",
          url: "/statusqris",
          params: {
            id: tx.id,
          },
        });
        if (statusResp && statusResp.success && statusResp.tx) {
          const payStatus = (statusResp.tx.status || "").toUpperCase();
          const currentTxStatus = payStatus === "PAID" ? "success" : payStatus === "EXPIRED" ? "expired" : "pending";
          const userToCheck = await User.findOne({
            _id: user._id,
            "historyDeposit.id": tx.id
          }, {
            "historyDeposit.$": 1,
            saldo: 1
          });
          const txInDb = userToCheck && userToCheck.historyDeposit && userToCheck.historyDeposit.length > 0 ? userToCheck.historyDeposit[0] : null;
          if (txInDb && txInDb.status !== currentTxStatus) {
            await editHistoryDeposit(user._id, tx.id, currentTxStatus);
          }
          if (currentTxStatus === "success" && txInDb && txInDb.status !== "success") {
            await User.findByIdAndUpdate(user._id, {
              $inc: {
                saldo: finalBalance
              },
            });
          }
          if (["success", "expired", "cancel"].includes(currentTxStatus)) {
            clearInterval(intervalId);
          }
        }
      } catch (pollError) {
        console.error(`Gagal cek status deposit (ID: ${tx.id}):`, pollError?.response?.data || pollError.message);
      }
    }, 1000);
  } catch (error) {
    const apiError = error.response?.data;
    res.status(500).json({
      success: false,
      message: apiError?.data?.message || apiError?.message || "Terjadi kesalahan internal saat memproses deposit.",
      error: apiError || error.message,
    });
  }
});

router.post("/withdraw/create", requireLogin, async (req, res) => {
  const user = await User.findById(req.session.userId);
  if (!user) {
    return res.status(401).json({
      success: false,
      message: "User tidak ditemukan atau sesi tidak valid."
    });
  }

  const { nominal, metode, rekening, nama } = req.body;

  if (!nominal || isNaN(nominal)) {
    return res.status(400).json({
      success: false,
      message: "Nominal harus berupa angka."
    });
  }

  const amount = parseInt(nominal);

  if (!metode || !rekening || !nama) {
    return res.status(400).json({
      success: false,
      message: "Metode, rekening, dan nama wajib diisi."
    });
  }

  if (user.saldo < amount) {
    return res.status(400).json({
      success: false,
      message: "Saldo tidak mencukupi."
    });
  }

  const reff_id = generateReffId();

  const formData = {
    api_key: process.env.ATLAN_API_KEY,
    reff_id,
    nominal: amount,
    metode,
    rekening,
    nama,
  };

  try {
    const response = await cloudscraper.post(`${BASE_URL}/withdraw/create`, {
      body: qs.stringify(formData),
      headers: cloudscraperHeaders,
    });

    const result = JSON.parse(response);

    if (!result?.status || !result?.data) {
      return res.status(502).json({
        success: false,
        message: result?.message || "Gagal membuat permintaan withdraw.",
        error: result,
      });
    }

    const wd = result.data;

    // potong saldo
    await User.findByIdAndUpdate(user._id, {
      $inc: { saldo: -amount }
    });

    const historyData = {
      id: wd.id,
      reff_id: wd.reff_id,
      nominal: amount,
      metode,
      rekening,
      nama,
      status: wd.status,
      created_at: wd.created_at ? new Date(wd.created_at) : new Date(),
    };

    await tambahHistoryOrder(user._id, historyData);

    res.status(200).json({
      success: true,
      data: wd
    });

    // polling status
    const intervalId = setInterval(async () => {
      try {
        const statusRes = await cloudscraper.post(`${BASE_URL}/withdraw/status`, {
          body: qs.stringify({
            api_key: process.env.ATLAN_API_KEY,
            id: wd.id,
          }),
          headers: cloudscraperHeaders,
        });

        const statusData = JSON.parse(statusRes);

        if (statusData?.status && statusData?.data) {
          const currStatus = statusData.data.status;

          await editHistoryOrder(user._id, wd.id, {
            status: currStatus,
          });

          // refund kalau gagal
          if (currStatus === "failed" || currStatus === "cancel") {
            await User.findByIdAndUpdate(user._id, {
              $inc: { saldo: amount }
            });
          }

          if (["success", "failed", "cancel"].includes(currStatus)) {
            clearInterval(intervalId);
          }
        }
      } catch (err) {
        console.error("Polling withdraw error:", err.message);
      }
    }, 3000);

  } catch (error) {
    const apiError = error.response?.data;
    return res.status(500).json({
      success: false,
      message: apiError?.message || "Terjadi kesalahan saat withdraw.",
      error: apiError || error.message,
    });
  }
});

router.post("/withdraw/status", requireLogin, async (req, res) => {
  const user = await User.findById(req.session.userId);
  if (!user) {
    return res.status(401).json({
      success: false,
      message: "User tidak ditemukan atau sesi tidak valid."
    });
  }

  const { id } = req.body;

  if (!id) {
    return res.status(400).json({
      success: false,
      message: "ID withdraw harus diisi."
    });
  }

  try {
    const response = await cloudscraper.post(`${BASE_URL}/withdraw/status`, {
      body: qs.stringify({
        api_key: process.env.ATLAN_API_KEY,
        id,
      }),
      headers: cloudscraperHeaders,
    });

    const result = JSON.parse(response);

    if (!result?.status || !result?.data) {
      return res.status(502).json({
        success: false,
        message: "Gagal cek status withdraw.",
        error: result,
      });
    }

    res.status(200).json({
      success: true,
      data: result.data,
    });

  } catch (error) {
    const apiError = error.response?.data;
    res.status(500).json({
      success: false,
      message: apiError?.message || "Gagal cek status withdraw.",
      error: apiError || error.message,
    });
  }
});

router.post("/deposit/status", requireLogin, async (req, res) => {
  const user = await User.findById(req.session.userId);
  if (!user) {
    return res.status(401).json({
      success: false,
      message: "User tidak ditemukan atau sesi tidak valid."
    });
  }
  const {
    id
  } = req.body;
  if (!id) {
    return res.status(400).json({
      success: false,
      message: "ID deposit harus diisi.",
    });
  }
  try {
    const userHistory = await User.findOne({
      _id: user._id,
      "historyDeposit.id": id
    }, {
      "historyDeposit.$": 1
    });
    if (!userHistory || userHistory.historyDeposit.length === 0) {
      return res.status(404).json({
        success: false,
        message: "ID deposit tidak ditemukan dalam riwayat Anda.",
      });
    }
    const depositInDb = userHistory.historyDeposit[0];
    const statusResp = await payDigitalRequest({
      method: "GET",
      url: "/statusqris",
      params: { id },
    });
    if (!statusResp?.success || !statusResp?.tx) {
      return res.status(502).json({
        success: false,
        message: statusResp?.error || "Gagal memeriksa status deposit ke provider.",
        error: statusResp,
      });
    }
    const payStatus = (statusResp.tx.status || "").toUpperCase();
    const mappedStatus = payStatus === "PAID" ? "success" : payStatus === "EXPIRED" ? "expired" : "pending";
    const responseData = {
      id: statusResp.tx.id,
      reff_id: depositInDb?.reff_id || null,
      nominal: depositInDb?.nominal ?? (parseInt(statusResp.tx.amount) || 0),
      tambahan: depositInDb?.tambahan || 0,
      fee: depositInDb?.fee ?? 250,
      get_balance: depositInDb?.get_balance ?? (parseInt(statusResp.tx.amount) || 0),
      metode: depositInDb?.metode || null,
      status: mappedStatus,
      qr_image: depositInDb?.qr_image || null,
      pay_url: depositInDb?.tujuan || null,
      expired_at: depositInDb?.expired_at || statusResp.tx.expiredAt || null,
      created_at: depositInDb?.created_at || statusResp.tx.createdAt || null,
    };
    return res.status(200).json({
      success: true,
      data: responseData,
    });
  } catch (error) {
    const apiError = error.response?.data;
    return res.status(500).json({
      success: false,
      message: apiError?.data?.message || apiError?.message || "Terjadi kesalahan internal saat memeriksa status deposit.",
      error: apiError || error.message,
    });
  }
});

router.post("/deposit/cancel", requireLogin, async (req, res) => {
  const user = await User.findById(req.session.userId);
  if (!user) {
    return res.status(401).json({
      success: false,
      message: "User tidak ditemukan atau sesi tidak valid."
    });
  }
  const {
    id
  } = req.body;
  if (!id) {
    return res.status(400).json({
      success: false,
      message: "ID deposit harus diisi.",
    });
  }
  try {
    const userHistory = await User.findOne({
      _id: user._id,
      "historyDeposit.id": id
    }, {
      "historyDeposit.$": 1
    });
    if (!userHistory || userHistory.historyDeposit.length === 0) {
      return res.status(404).json({
        success: false,
        message: "ID deposit tidak ditemukan dalam riwayat Anda.",
      });
    }
    const cancelResp = await payDigitalRequest({
      method: "POST",
      url: "/cancelqris",
      headers: {
        "Content-Type": "application/json",
      },
      data: { id },
    });
    if (!cancelResp?.success) {
      return res.status(502).json({
        success: false,
        message: cancelResp?.error || "Gagal membatalkan deposit ke provider.",
        error: cancelResp,
      });
    }
    await editHistoryDeposit(user._id, id, "cancel");
    return res.status(200).json({
      success: true,
      data: {
        id,
        status: "cancel",
        created_at: new Date(),
      },
    });
  } catch (error) {
    const apiError = error.response?.data;
    return res.status(500).json({
      success: false,
      message: apiError?.data?.message || apiError?.message || "Terjadi kesalahan internal saat membatalkan deposit.",
      error: apiError || error.message,
    });
  }
});

router.post("/layanan/price-list", requireLogin, async (req, res) => {
  const user = await User.findById(req.session.userId);
  if (!user) {
    return res.status(401).json({
      success: false,
      message: "User tidak ditemukan atau sesi tidak valid."
    });
  }
  const {
    code
  } = req.body;
  try {
    const formDataToAtlantic = {
      api_key: process.env.ATLAN_API_KEY,
      type: 'prabayar',
      code: code,
    };
    const response = await cloudscraper.post(`${BASE_URL}/layanan/price_list`, {
      body: qs.stringify(formDataToAtlantic),
      headers: cloudscraperHeaders
    });
    const resultFromAtlantic = JSON.parse(response);
    if (!resultFromAtlantic || !resultFromAtlantic.status || !Array.isArray(resultFromAtlantic.data)) {
      return res.status(502).json({
        success: false,
        message: resultFromAtlantic?.message || "Gagal mendapatkan daftar harga dari provider.",
        error: resultFromAtlantic?.data || resultFromAtlantic,
      });
    }
    const modifiedData = resultFromAtlantic.data.map((item) => {
      let originalPrice = parseInt(item.price) || 0;
      let modifiedPrice = originalPrice;
      if (user.role === "user") {
        modifiedPrice = originalPrice + 10;
      } else if (user.role === "reseller") {
        modifiedPrice = originalPrice + 7;
      }
      return {
        code: item.code,
        name: item.name,
        category: item.category,
        type: item.type,
        provider: item.provider,
        price: modifiedPrice.toString(),
        note: item.note,
        status: item.status,
        img_url: item.img_url,
      };
    });
    return res.status(200).json({
      success: true,
      data: modifiedData,
    });
  } catch (error) {
    const apiError = error.response?.data;
    return res.status(500).json({
      success: false,
      message: apiError?.message || "Terjadi kesalahan internal saat memproses permintaan.",
      error: apiError || error.message,
    });
  }
});

router.get("/produk", requireLogin, async (req, res) => {
  const {
    category
  } = req.query;
  const user = await User.findById(req.session.userId);
  if (!user) {
    return res.status(400).json({
      success: false,
      message: "User tidak ditemukan."
    });
  }
  try {
    const formDataToAtlantic = {
      api_key: process.env.ATLAN_API_KEY,
      type: "prabayar",
      code: "",
    };
    const response = await cloudscraper.post(`${BASE_URL}/layanan/price_list`, {
      body: qs.stringify(formDataToAtlantic),
      headers: cloudscraperHeaders,
    });
    const result = JSON.parse(response);
    const allProduk = result.data || [];
    const filtered = category ?
      allProduk.filter((item) => item.category?.toLowerCase() === category.toLowerCase()) :
      allProduk;
    const providerMap = {};
    filtered.forEach(item => {
      if (!providerMap[item.provider]) {
        providerMap[item.provider] = {
          provider: item.provider,
          img_url: item.img_url,
        };
      }
    });
    const listProvider = Object.values(providerMap);
    return res.json({
      success: true,
      data: listProvider
    });
  } catch (error) {
    const errData = error.response?.data;
    return res.status(500).json({
      success: false,
      message: errData?.message || "Gagal memproses data provider.",
      error: errData || error.message,
    });
  }
});

router.get("/produk-provider", requireLogin, async (req, res) => {
  const {
    provider
  } = req.query;
  const user = await User.findById(req.session.userId);
  if (!user) {
    return res.status(400).json({
      success: false,
      message: "User tidak ditemukan."
    });
  }
  try {
    const formDataToAtlantic = {
      api_key: process.env.ATLAN_API_KEY,
      type: "prabayar",
      code: "",
    };
    const response = await cloudscraper.post(`${BASE_URL}/layanan/price_list`, {
      body: qs.stringify(formDataToAtlantic),
      headers: cloudscraperHeaders,
    });
    const result = JSON.parse(response);
    const allProduk = result.data || [];
    if (provider) {
      const produkByProvider = allProduk.filter(item =>
        item.provider?.toLowerCase() === provider.toLowerCase()
      );
      return res.json({
        success: true,
        data: produkByProvider
      });
    }
    const providerMap = {};
    allProduk.forEach(item => {
      if (!providerMap[item.provider]) {
        providerMap[item.provider] = {
          provider: item.provider,
          img_url: item.img_url,
        };
      }
    });
    const listProvider = Object.values(providerMap);
    return res.json({
      success: true,
      data: listProvider
    });
  } catch (error) {
    const errData = error.response?.data;
    return res.status(500).json({
      success: false,
      message: errData?.message || "Gagal memproses data produk/provider.",
      error: errData || error.message,
    });
  }
});

router.post("/order/create", requireLogin, async (req, res) => {
  const user = await User.findById(req.session.userId);
  if (!user) {
    return res.status(401).json({
      success: false,
      message: "User tidak ditemukan atau sesi tidak valid."
    });
  }
  const {
    code,
    tujuan: target
  } = req.body;
  if (!code || !target) {
    return res.status(400).json({
      success: false,
      message: "Kode layanan dan tujuan harus diisi.",
    });
  }
  try {
    const formDataToAtlanticPriceList = {
      api_key: process.env.ATLAN_API_KEY,
      type: "prabayar",
      code: code,
    };
    const priceResponse = await cloudscraper.post(`${BASE_URL}/layanan/price_list`, {
      body: qs.stringify(formDataToAtlanticPriceList),
      headers: cloudscraperHeaders,
    });
    const priceListResult = JSON.parse(priceResponse);
    if (!priceListResult || !priceListResult.status || !priceListResult.data) {
      return res.status(502).json({
        success: false,
        message: priceListResult?.message || "Gagal mendapatkan daftar harga dari provider.",
        error: priceListResult?.data || priceListResult,
      });
    }
    const productList = Array.isArray(priceListResult.data) ? priceListResult.data : [priceListResult.data];
    const product = productList.find((item) => item.code === code && item.status === "available");
    if (!product) {
      return res.status(400).json({
        success: false,
        message: "Kode layanan tidak ditemukan atau tidak tersedia.",
      });
    }
    let originalPrice = parseInt(product.price) || 0;
    let modifiedPrice = originalPrice;
    if (user.role === "user") {
      modifiedPrice = originalPrice + 10;
    } else if (user.role === "reseller") {
      modifiedPrice = originalPrice + 7;
    }
    if (user.saldo < modifiedPrice) {
      return res.status(400).json({
        success: false,
        message: "Saldo Anda tidak mencukupi untuk melakukan transaksi ini.",
      });
    }
    const reff_id = generateReffId();
    const formDataToAtlanticCreate = {
      api_key: process.env.ATLAN_API_KEY,
      code: code,
      reff_id: reff_id,
      target: target,
      type: "prabayar",
    };
    const createResponse = await cloudscraper.post(`${BASE_URL}/transaksi/create`, {
      body: qs.stringify(formDataToAtlanticCreate),
      headers: cloudscraperHeaders,
    });
    const createResult = JSON.parse(createResponse);
    if (!createResult || !createResult.status || !createResult.data) {
      return res.status(502).json({
        success: false,
        message: createResult?.message || "Gagal membuat transaksi ke provider.",
        error: createResult?.data || createResult,
      });
    }
    const transactionDetails = createResult.data;
    await User.findByIdAndUpdate(user._id, {
      $inc: {
        saldo: -modifiedPrice
      },
    });
    const historyDataForDb = {
      id: transactionDetails.id,
      reff_id: transactionDetails.reff_id,
      layanan: transactionDetails.layanan,
      code: transactionDetails.code,
      target: transactionDetails.target,
      price: modifiedPrice.toString(),
      sn: transactionDetails.sn || null,
      status: transactionDetails.status,
      created_at: transactionDetails.created_at ?
        new Date(transactionDetails.created_at) :
        new Date(),
    };
    await tambahHistoryOrder(user._id, historyDataForDb);
    const maxPollingTime = 5 * 60 * 1000;
    const startTime = Date.now();
    const intervalId = setInterval(async () => {
      try {
        const statusResponse = await cloudscraper.post(`${BASE_URL}/transaksi/status`, {
          body: qs.stringify({
            api_key: process.env.ATLAN_API_KEY,
            id: transactionDetails.id,
            type: "prabayar",
          }),
          headers: cloudscraperHeaders,
        });
        const statusUpdateData = JSON.parse(statusResponse);
        if (statusUpdateData && statusUpdateData.status && statusUpdateData.data) {
          const currentTxStatus = statusUpdateData.data.status;
          const currentSn = statusUpdateData.data.sn || null;
          await editHistoryOrder(user._id, transactionDetails.id, {
            status: currentTxStatus,
            sn: currentSn,
          });
          if (currentTxStatus === "success") {
            clearInterval(intervalId);
          }
          if (["failed", "cancel"].includes(currentTxStatus)) {
            const orderInDb = await User.findOne({
              _id: user._id,
              "historyOrder.id": transactionDetails.id,
              "historyOrder.status": {
                $ne: "failed_refunded"
              }
            }, {
              "historyOrder.$": 1
            });
            if (orderInDb && orderInDb.historyOrder.length > 0 && orderInDb.historyOrder[0].status !== "failed_refunded") {
              await User.updateOne({
                _id: user._id,
                "historyOrder.id": transactionDetails.id
              }, {
                $inc: {
                  saldo: modifiedPrice
                },
                $set: {
                  "historyOrder.$.status": "failed_refunded"
                }
              });
            }
            clearInterval(intervalId);
          }
          if (
            ["success", "failed", "cancel"].includes(currentTxStatus) ||
            Date.now() - startTime > maxPollingTime
          ) {
            clearInterval(intervalId);
          }
        }
      } catch (pollError) {
        console.error(pollError?.response?.data || pollError.message);
      }
    }, 1000);
    return res.status(200).json({
      success: true,
      data: {
        ...transactionDetails,
        price: modifiedPrice.toString(),
      },
    });
  } catch (error) {
    const apiError = error.response?.data;
    return res.status(500).json({
      success: false,
      message: apiError?.message || "Terjadi kesalahan internal saat memproses order.",
      error: apiError || error.message,
    });
  }
});

router.post("/order/check", requireLogin, async (req, res) => {
  const user = await User.findById(req.session.userId);
  if (!user) {
    return res.status(401).json({
      success: false,
      message: "User tidak ditemukan atau sesi tidak valid."
    });
  }
  const {
    id
  } = req.body;
  if (!id) {
    return res.status(400).json({
      success: false,
      message: "ID order harus diisi.",
    });
  }
  try {
    const userWithOrder = await User.findOne({
      _id: user._id,
      "historyOrder.id": id
    }, {
      "historyOrder.$": 1
    });
    if (!userWithOrder || !userWithOrder.historyOrder.length) {
      return res.status(404).json({
        success: false,
        message: "Order Tidak Ditemukan Di Mutasi Anda.",
      });
    }
    const formDataToAtlanticStatus = {
      api_key: process.env.ATLAN_API_KEY,
      id: id,
      type: "prabayar",
    };
    const statusResponse = await cloudscraper.post(`${BASE_URL}/transaksi/status`, {
      body: qs.stringify(formDataToAtlanticStatus),
      headers: cloudscraperHeaders,
    });
    const statusResult = JSON.parse(statusResponse);
    if (!statusResult || !statusResult.status || !statusResult.data) {
      return res.status(502).json({
        success: false,
        message: statusResult?.message || "Gagal memeriksa status order dari provider.",
        error: statusResult?.data || statusResult,
      });
    }
    const orderDetails = statusResult.data;
    return res.status(200).json({
      status: true,
      data: {
        id: orderDetails.id,
        reff_id: orderDetails.reff_id,
        layanan: orderDetails.layanan,
        code: orderDetails.code,
        target: orderDetails.target,
        price: orderDetails.price,
        sn: orderDetails.sn || null,
        status: orderDetails.status,
        created_at: orderDetails.created_at,
      },
      code: 200,
    });
  } catch (error) {
    const apiError = error.response?.data;
    return res.status(500).json({
      success: false,
      message: apiError?.message || "Terjadi kesalahan internal saat memeriksa status order.",
      error: apiError || error.message,
    });
  }
});

module.exports = router;
