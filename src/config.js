import dotenv from 'dotenv';
dotenv.config();

export const RPC_URL       = process.env.RPC_URL;
export const OWNER_ADDRESS = process.env.OWNER_ADDRESS;
export const CHAIN_ID      = Number(process.env.CHAIN_ID) || 8453;
export const THEGRAPH_API_KEY = process.env.THEGRAPH_API_KEY;
export const BASESCAN_API_KEY = process.env.ETHERSCAN_API_KEY;

export const CONTRACTS = {
  POSITION_MANAGER: '0x46A15B0b27311cedF172AB29E4f4766fbE7F4364',
  FACTORY:          '0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865',
  MASTERCHEF:       '0xC6A2Db661D5a5690172d8eB0a7DEA2d3008665A3',
  MASTERCHEF_LENS:  '0x83bD7B24C29583431a8573297221524556d42416'
};