import { PublicKey, type AccountInfo } from "@solana/web3.js";
import { DEVNET_USDC, deviceId, discriminator, registryAddresses } from "@pathnod/solana";

export function eligibilityAccounts() {
  const program = new PublicKey("5V9pXQN5dQkRBSTsaezBg6qLRC3mbLj21Ny3j7xtuHTd");
  const protocol = Buffer.alloc(32, 1), key = Buffer.alloc(32, 2), device = deviceId(key);
  const addresses = registryAddresses(program, protocol);
  const account = (data: Buffer): AccountInfo<Buffer> => ({ owner: program, executable: false, lamports: 1_000_000, data });
  const config = Buffer.alloc(185);
  discriminator("account", "ProtocolConfig").copy(config);
  program.toBuffer().copy(config, 8);
  protocol.copy(config, 40);
  config.writeUInt32LE(604800, 72);
  program.toBuffer().copy(config, 76);
  config.writeUInt32LE(3, 108);
  DEVNET_USDC.toBuffer().copy(config, 112);
  config.writeBigUInt64LE(50_000n, 144);
  config[152] = 3;
  addresses.escrow.toBuffer().copy(config, 153);
  const deviceData = Buffer.alloc(126);
  discriminator("account", "DeviceRegistry").copy(deviceData);
  device.copy(deviceData, 8); key.copy(deviceData, 40); deviceData[72] = 1;
  deviceData.writeBigInt64LE(1n, 75);
  const epochData = (paid: number, independent = paid) => {
    const data = Buffer.alloc(75);
    discriminator("account", "DeviceEpoch").copy(data);
    data.writeUInt16LE(independent, 8); data[10] = paid;
    return account(data);
  };
  return { program, protocol, device, config, deviceData, account, epochData, addresses,
    rows: [account(config), account(deviceData), null] as (AccountInfo<Buffer> | null)[],
  };
}
