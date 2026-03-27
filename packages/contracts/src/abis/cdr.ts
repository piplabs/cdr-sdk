// Auto-generated from ICDR.sol — do not edit manually
// Regenerate: cd story/contracts && forge build, then copy abi from out/ICDR.sol/ICDR.json

export const cdrAbi = [
  {
    "type": "function",
    "name": "allocate",
    "inputs": [
      {
        "name": "updatable",
        "type": "bool",
        "internalType": "bool"
      },
      {
        "name": "writeConditionAddr",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "readConditionAddr",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "writeconditionData",
        "type": "bytes",
        "internalType": "bytes"
      },
      {
        "name": "readconditionData",
        "type": "bytes",
        "internalType": "bytes"
      }
    ],
    "outputs": [
      {
        "name": "newVaultUuid",
        "type": "uint32",
        "internalType": "uint32"
      }
    ],
    "stateMutability": "payable"
  },
  {
    "type": "function",
    "name": "allocateFee",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "baseFee",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "read",
    "inputs": [
      {
        "name": "uuid",
        "type": "uint32",
        "internalType": "uint32"
      },
      {
        "name": "accessAuxData",
        "type": "bytes",
        "internalType": "bytes"
      },
      {
        "name": "requesterPubKey",
        "type": "bytes",
        "internalType": "bytes"
      }
    ],
    "outputs": [],
    "stateMutability": "payable"
  },
  {
    "type": "function",
    "name": "readFee",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "setAllocateFee",
    "inputs": [
      {
        "name": "newAllocateFee",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "setBaseFee",
    "inputs": [
      {
        "name": "newBaseFee",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "setReadFee",
    "inputs": [
      {
        "name": "newReadFee",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "setWriteFee",
    "inputs": [
      {
        "name": "newWriteFee",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "submitEncryptedPartialDecryption",
    "inputs": [
      {
        "name": "round",
        "type": "uint32",
        "internalType": "uint32"
      },
      {
        "name": "pid",
        "type": "uint32",
        "internalType": "uint32"
      },
      {
        "name": "encryptedPartial",
        "type": "bytes",
        "internalType": "bytes"
      },
      {
        "name": "ephemeralPubKey",
        "type": "bytes",
        "internalType": "bytes"
      },
      {
        "name": "pubShare",
        "type": "bytes",
        "internalType": "bytes"
      },
      {
        "name": "requesterPubKey",
        "type": "bytes",
        "internalType": "bytes"
      },
      {
        "name": "ciphertext",
        "type": "bytes",
        "internalType": "bytes"
      },
      {
        "name": "uuid",
        "type": "uint32",
        "internalType": "uint32"
      },
      {
        "name": "signature",
        "type": "bytes",
        "internalType": "bytes"
      }
    ],
    "outputs": [],
    "stateMutability": "payable"
  },
  {
    "type": "function",
    "name": "uuid",
    "inputs": [],
    "outputs": [
      {
        "name": "uuid",
        "type": "uint32",
        "internalType": "uint32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "vaults",
    "inputs": [
      {
        "name": "uuid",
        "type": "uint32",
        "internalType": "uint32"
      }
    ],
    "outputs": [
      {
        "name": "vault",
        "type": "tuple",
        "internalType": "struct ICDR.Vault",
        "components": [
          {
            "name": "updatable",
            "type": "bool",
            "internalType": "bool"
          },
          {
            "name": "writeConditionAddr",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "readConditionAddr",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "writeConditionData",
            "type": "bytes",
            "internalType": "bytes"
          },
          {
            "name": "readConditionData",
            "type": "bytes",
            "internalType": "bytes"
          },
          {
            "name": "encryptedData",
            "type": "bytes",
            "internalType": "bytes"
          }
        ]
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "write",
    "inputs": [
      {
        "name": "uuid",
        "type": "uint32",
        "internalType": "uint32"
      },
      {
        "name": "accessAuxData",
        "type": "bytes",
        "internalType": "bytes"
      },
      {
        "name": "encryptedData",
        "type": "bytes",
        "internalType": "bytes"
      }
    ],
    "outputs": [],
    "stateMutability": "payable"
  },
  {
    "type": "function",
    "name": "writeFee",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "maxEncryptedDataSize",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "event",
    "name": "EncryptedPartialDecryptionSubmitted",
    "inputs": [
      {
        "name": "validator",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "round",
        "type": "uint32",
        "indexed": false,
        "internalType": "uint32"
      },
      {
        "name": "pid",
        "type": "uint32",
        "indexed": false,
        "internalType": "uint32"
      },
      {
        "name": "encryptedPartial",
        "type": "bytes",
        "indexed": false,
        "internalType": "bytes"
      },
      {
        "name": "ephemeralPubKey",
        "type": "bytes",
        "indexed": false,
        "internalType": "bytes"
      },
      {
        "name": "pubShare",
        "type": "bytes",
        "indexed": false,
        "internalType": "bytes"
      },
      {
        "name": "requesterPubKey",
        "type": "bytes",
        "indexed": false,
        "internalType": "bytes"
      },
      {
        "name": "ciphertext",
        "type": "bytes",
        "indexed": false,
        "internalType": "bytes"
      },
      {
        "name": "uuid",
        "type": "uint32",
        "indexed": false,
        "internalType": "uint32"
      },
      {
        "name": "signature",
        "type": "bytes",
        "indexed": false,
        "internalType": "bytes"
      },
      {
        "name": "fee",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "VaultAllocated",
    "inputs": [
      {
        "name": "uuid",
        "type": "uint32",
        "indexed": false,
        "internalType": "uint32"
      },
      {
        "name": "updatable",
        "type": "bool",
        "indexed": false,
        "internalType": "bool"
      },
      {
        "name": "writeConditionAddr",
        "type": "address",
        "indexed": false,
        "internalType": "address"
      },
      {
        "name": "readConditionAddr",
        "type": "address",
        "indexed": false,
        "internalType": "address"
      },
      {
        "name": "writeConditionData",
        "type": "bytes",
        "indexed": false,
        "internalType": "bytes"
      },
      {
        "name": "readConditionData",
        "type": "bytes",
        "indexed": false,
        "internalType": "bytes"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "VaultRead",
    "inputs": [
      {
        "name": "uuid",
        "type": "uint32",
        "indexed": false,
        "internalType": "uint32"
      },
      {
        "name": "requester",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "ciphertext",
        "type": "bytes",
        "indexed": false,
        "internalType": "bytes"
      },
      {
        "name": "requesterPubKey",
        "type": "bytes",
        "indexed": false,
        "internalType": "bytes"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "VaultWritten",
    "inputs": [
      {
        "name": "uuid",
        "type": "uint32",
        "indexed": false,
        "internalType": "uint32"
      },
      {
        "name": "encryptedData",
        "type": "bytes",
        "indexed": false,
        "internalType": "bytes"
      }
    ],
    "anonymous": false
  }
] as const;

