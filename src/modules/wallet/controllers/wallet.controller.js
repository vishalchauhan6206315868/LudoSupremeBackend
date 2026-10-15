const walletService = require("../services/wallet.service");

// ==========================================
// 1. GET LOGGED-IN USER WALLET
// GET /api/wallet
// ==========================================
exports.getWallet = async (req, res) => {
  try {
    const userId = req.user._id;
    const wallet = await walletService.getOrCreateWallet(userId);

    return res.status(200).json({
      success: true,
      message: "Wallet fetched successfully",
      data: {
        wallet: {
          _id: wallet._id,
          user: wallet.user,
          balance: wallet.balance,
          createdAt: wallet.createdAt,
          updatedAt: wallet.updatedAt,
        },
      },
    });
  } catch (error) {
    console.error("Get Wallet Error:", error);
    return res.status(error.status || 500).json({
      success: false,
      message: error.status && error.status < 500 ? error.message : "Internal Server Error",
    });
  }
};

// ==========================================
// 2. GET CURRENT USER WALLET BALANCE
// GET /api/wallet/me
// ==========================================
exports.getMyBalance = async (req, res) => {
  try {
    const userId = req.user._id;
    const wallet = await walletService.getOrCreateWallet(userId);

    return res.status(200).json({
      success: true,
      message: "Wallet balance fetched successfully",
      data: {
        balance: wallet.balance,
      },
    });
  } catch (error) {
    console.error("Get Wallet Balance Error:", error);
    return res.status(error.status || 500).json({
      success: false,
      message: error.status && error.status < 500 ? error.message : "Internal Server Error",
    });
  }
};

// ==========================================
// 3. GET WALLET TRANSACTION HISTORY
// GET /api/wallet/transactions
// ==========================================
exports.getTransactions = async (req, res) => {
  try {
    const userId = req.user._id;
    const { page, limit } = req.query;

    const result = await walletService.getWalletTransactions(
      userId,
      page,
      limit
    );

    return res.status(200).json({
      success: true,
      message: "Wallet transactions fetched successfully",
      data: {
        wallet: {
          balance: result.wallet.balance,
        },
        transactions: result.transactions,
        pagination: result.pagination,
      },
    });
  } catch (error) {
    console.error("Get Transactions Error:", error);
    return res.status(error.status || 500).json({
      success: false,
      message: error.status && error.status < 500 ? error.message : "Internal Server Error",
    });
  }
};
