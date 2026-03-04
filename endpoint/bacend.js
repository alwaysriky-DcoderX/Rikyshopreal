const express = require("express");
const qs = require("qs");
const multer = require('multer');
const cloudscraper = require("cloudscraper");
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
 const PAYDIGITAL_DEFAULT_SERVER = process.env.PAYDIGITAL_DEFAULT_SERVER;
 const PAYDIGITAL_DEFAULT_QRISTYPE = process.env.PAYDIGITAL_DEFAULT_QRISTYPE || "1";
 const PAYDIGITAL_FLAT_FEE = 250;

 async function paydigitalGet(path, query) {
   const url = query && Object.keys(query).length
     ? `${PAYDIGITAL_BASE_URL}${path}?${qs.stringify(query)}`
     : `${PAYDIGITAL_BASE_URL}${path}`;
   return cloudscraper.get(url, {
     headers: {
       Accept: "application/json",
       "x-api-key": PAYDIGITAL_API_KEY,
     },
   });
 }

 async function paydigitalPost(path, body) {
   return cloudscraper.post(`${PAYDIGITAL_BASE_URL}${path}`, {
     body: JSON.stringify(body || {}),
     headers: {
       Accept: "application/json",
       "Content-Type": "application/json",
       "x-api-key": PAYDIGITAL_API_KEY,
     },
   });
 }

 async function paydigitalCreateQrisWithFailover(payload) {
   const requestedServerRaw = payload?.server ?? (PAYDIGITAL_DEFAULT_SERVER ? parseInt(PAYDIGITAL_DEFAULT_SERVER) : undefined);
   const requestedServer = requestedServerRaw ? parseInt(requestedServerRaw) : undefined;

   const serversToTry = requestedServer ? [requestedServer] : [];
   [1, 2, 3].forEach((s) => {
     if (!serversToTry.includes(s)) serversToTry.push(s);
   });

   let lastErr;
   for (let i = 0; i < serversToTry.length; i++) {
     const server = serversToTry[i];
     try {
       const respRaw = await paydigitalPost("/createqris", {
         ...payload,
         server,
         qristype: payload?.qristype || PAYDIGITAL_DEFAULT_QRISTYPE,
       });
       const parsed = JSON.parse(respRaw);
       if (parsed?.ok) {
         const fallbackUsed = requestedServer ? server !== requestedServer : i > 0;
         if (fallbackUsed) {
           parsed.tx = {
             ...(parsed.tx || {}),
             fallbackUsed: true,
             originalServer: requestedServer,
             actualServer: server,
           };
         }
         return parsed;
       }
       lastErr = new Error(parsed?.error || "PAYDIGITAL_CREATE_FAILED");
     } catch (e) {
       lastErr = e;
     }
   }
   throw lastErr || new Error("PAYDIGITAL_CREATE_FAILED");
 }

async function getAtlanticDepositMethods() {
  try {
    const formData = {
      api_key: process.env.ATLAN_API_KEY,
    };
    const response = await cloudscraper.post(`${BASE_URL}/deposit/metode`, {
      body: qs.stringify(formData),
      headers: cloudscraperHeaders,
    });
    const result = JSON.parse(response);
    if (result && result.status && Array.isArray(result.data)) {
      return result.data;
    }
    return null;
  } catch (error) {
    console.error("Gagal mengambil metode deposit dari Atlantic:", error?.response?.data || error.message);
    return null;
  }
}

async function getPaydigitalDepositChannels(server, qristype) {
  if (!PAYDIGITAL_API_KEY) return null;
  try {
    const respRaw = await paydigitalGet("/api/payment-channels", {
      server: server ? parseInt(server) : undefined,
      qristype: qristype || undefined,
    });
    const parsed = JSON.parse(respRaw);
    if (parsed?.ok && Array.isArray(parsed?.data)) return parsed;
    return null;
  } catch (e) {
    console.error("Gagal mengambil channel Paydigital:", e?.response?.data || e.message);
    return null;
  }
}

router.post("/deposit/metode", requireLogin, async (req, res) => {
  try {
    if (!PAYDIGITAL_API_KEY) {
      return res.status(500).json({
        success: false,
        message: "PAYDIGITAL_API_KEY belum di-set di environment.",
      });
    }

    const { server, qristype } = req.body || {};
    const channelData = await getPaydigitalDepositChannels(server, qristype);
    if (!channelData) {
      return res.status(502).json({
        success: false,
        message: "Gagal mengambil daftar metode dari provider.",
      });
    }

    const fullUrl = `${req.protocol}://${req.get("host")}`;
    const metodeFormatted = channelData.data.map((ch) => {
      const label = ch.name || `Server ${ch.server}`;
      return {
        metode: ch.code,
        type: "qris",
        name: label,
        min: 1,
        max: 0,
        fee: PAYDIGITAL_FLAT_FEE,
        fee_persen: "0.00",
        status: ch.status,
        server: ch.server,
        qristype: ch.qristype,
        img_url: `${fullUrl}/media/metode/default.png`,
      };
    });
    return res.status(200).json({
      success: true,
      message: "Daftar metode deposit berhasil difilter",
      metode: metodeFormatted,
      defaultServer: channelData.defaultServer,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Gagal mengambil metode deposit",
      error: error?.response?.data || error.message,
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
    metode: metodePilihanPengguna,
    server,
    qristype,
    note
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

  if (!PAYDIGITAL_API_KEY) {
    return res.status(500).json({
      success: false,
      message: "PAYDIGITAL_API_KEY belum di-set di environment.",
    });
  }

  if (parsedNominal <= 0) {
    return res.status(400).json({
      success: false,
      message: "Nominal tidak valid.",
    });
  }

  const selectedServer = server ? parseInt(server) : undefined;
  const selectedQrisType = qristype || PAYDIGITAL_DEFAULT_QRISTYPE;

  try {
    const createResult = await paydigitalCreateQrisWithFailover({
      amount: parsedNominal,
      note: note || `Deposit ${user.username || user.email || user._id}`,
      server: selectedServer,
      qristype: selectedQrisType,
      metode: metodePilihanPengguna,
    });

    const tx = createResult.tx || {};
    const payment = createResult.payment || {};

    const creditedBalance = parseInt(tx.amount) || parsedNominal;
    const totalFee = PAYDIGITAL_FLAT_FEE;

    const historyDataForDb = {
      id: tx.id,
      reff_id: tx.ref_id || tx.id,
      nominal: creditedBalance,
      tambahan: 0,
      fee: totalFee,
      get_balance: creditedBalance,
      metode: "QRIS",
      bank: null,
      tujuan: null,
      atas_nama: null,
      status: tx.status,
      qr_image: payment.qr_link || tx.pay_url || null,
      created_at: tx.createdAt ? new Date(tx.createdAt) : new Date(),
    };
    await tambahHistoryDeposit(user._id, historyDataForDb);
    res.status(200).json({
      success: true,
      data: {
        ...tx,
        fee: totalFee,
        total: (parseInt(tx.total) || (creditedBalance + totalFee)),
        pay_url: tx.pay_url,
        qr_string: payment.qr_string,
        qr_link: payment.qr_link,
        get_balance: creditedBalance,
        server: tx.typeServer || tx.actualServer || selectedServer,
        qristype: tx.qrisType || selectedQrisType,
      },
    });
    const intervalId = setInterval(async () => {
      try {
        const statusRaw = await paydigitalGet("/statusqris", { id: tx.id });
        const statusData = JSON.parse(statusRaw);
        const currentTxStatus = statusData?.tx?.status;
        if (!currentTxStatus) return;

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
        if (currentTxStatus === "PAID" && txInDb && txInDb.status !== "PAID") {
          await User.findByIdAndUpdate(user._id, {
            $inc: { saldo: creditedBalance },
          });
        }
        if (["PAID", "EXPIRED", "CANCEL", "CANCELLED"].includes(currentTxStatus)) {
          clearInterval(intervalId);
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
    if (!PAYDIGITAL_API_KEY) {
      return res.status(500).json({
        success: false,
        message: "PAYDIGITAL_API_KEY belum di-set di environment.",
      });
    }

    const statusRaw = await paydigitalGet("/statusqris", { id });
    const statusData = JSON.parse(statusRaw);
    if (!statusData?.success || !statusData?.tx) {
      return res.status(502).json({
        success: false,
        message: statusData?.error || "Gagal memeriksa status deposit ke provider.",
        error: statusData,
      });
    }

    const depositDetails = statusData.tx;
    const creditedBalance = parseInt(depositDetails.amount) || 0;
    const responseData = {
      id: depositDetails.id,
      reff_id: depositDetails.ref_id || depositDetails.id,
      nominal: creditedBalance,
      tambahan: 0,
      fee: PAYDIGITAL_FLAT_FEE,
      get_balance: creditedBalance,
      metode: "QRIS",
      status: depositDetails.status,
      created_at: depositDetails.createdAt,
      paidAt: depositDetails.paidAt,
      total: depositDetails.total,
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
    if (!PAYDIGITAL_API_KEY) {
      return res.status(500).json({
        success: false,
        message: "PAYDIGITAL_API_KEY belum di-set di environment.",
      });
    }

    const cancelRaw = await paydigitalPost("/cancelqris", { id });
    const cancelRes = JSON.parse(cancelRaw);
    if (!cancelRes?.success) {
      return res.status(502).json({
        success: false,
        message: cancelRes?.error || "Gagal membatalkan deposit ke provider.",
        error: cancelRes,
      });
    }

    const cancelDetails = cancelRes;
    return res.status(200).json({
      success: true,
      data: {
        id,
        status: "CANCELLED",
        message: cancelDetails.message,
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
