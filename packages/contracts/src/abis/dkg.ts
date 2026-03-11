// Auto-generated from IDKG.sol — do not edit manually
// Regenerate: cd story/contracts && forge build, then copy abi from out/IDKG.sol/IDKG.json

export const dkgAbi = [
  {
    "type": "function",
    "name": "authenticateEnclaveReport",
    "inputs": [
      {
        "name": "enclaveReport",
        "type": "bytes",
        "internalType": "bytes"
      },
      {
        "name": "enclaveInstanceData",
        "type": "tuple",
        "internalType": "struct IDKG.EnclaveInstanceData",
        "components": [
          {
            "name": "round",
            "type": "uint32",
            "internalType": "uint32"
          },
          {
            "name": "validatorAddr",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "enclaveType",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "enclaveCommKey",
            "type": "bytes",
            "internalType": "bytes"
          },
          {
            "name": "dkgPubKey",
            "type": "bytes",
            "internalType": "bytes"
          }
        ]
      },
      {
        "name": "validationContext",
        "type": "bytes",
        "internalType": "bytes"
      }
    ],
    "outputs": [],
    "stateMutability": "payable"
  },
  {
    "type": "function",
    "name": "cancelUpgrade",
    "inputs": [
      {
        "name": "upgradeVersion",
        "type": "string",
        "internalType": "string"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "enclaveTypeData",
    "inputs": [
      {
        "name": "enclaveType",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "tuple",
        "internalType": "struct IDKG.EnclaveTypeData",
        "components": [
          {
            "name": "codeCommitment",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "validationHookAddr",
            "type": "address",
            "internalType": "address"
          }
        ]
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "fee",
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
    "name": "finalize",
    "inputs": [
      {
        "name": "round",
        "type": "uint32",
        "internalType": "uint32"
      },
      {
        "name": "validatorAddr",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "enclaveType",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "participantsRoot",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "globalPubKey",
        "type": "bytes",
        "internalType": "bytes"
      },
      {
        "name": "publicCoeffs",
        "type": "bytes[]",
        "internalType": "bytes[]"
      },
      {
        "name": "pubKeyShare",
        "type": "bytes",
        "internalType": "bytes"
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
    "name": "isEnclaveTypeWhitelisted",
    "inputs": [
      {
        "name": "enclaveType",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "minReqFinalizedParticipants",
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
    "name": "minReqRegisteredParticipants",
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
    "name": "operationalThreshold",
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
    "name": "register",
    "inputs": [
      {
        "name": "enclaveReport",
        "type": "bytes",
        "internalType": "bytes"
      },
      {
        "name": "enclaveInstanceData",
        "type": "tuple",
        "internalType": "struct IDKG.EnclaveInstanceData",
        "components": [
          {
            "name": "round",
            "type": "uint32",
            "internalType": "uint32"
          },
          {
            "name": "validatorAddr",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "enclaveType",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "enclaveCommKey",
            "type": "bytes",
            "internalType": "bytes"
          },
          {
            "name": "dkgPubKey",
            "type": "bytes",
            "internalType": "bytes"
          }
        ]
      },
      {
        "name": "startBlockHeight",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "startBlockHash",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "validationContext",
        "type": "bytes",
        "internalType": "bytes"
      }
    ],
    "outputs": [],
    "stateMutability": "payable"
  },
  {
    "type": "function",
    "name": "scheduleUpgrade",
    "inputs": [
      {
        "name": "activationHeight",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "upgradeVersion",
        "type": "string",
        "internalType": "string"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "setFee",
    "inputs": [
      {
        "name": "newFee",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "setMinReqFinalizedParticipants",
    "inputs": [
      {
        "name": "newMinReqFinalizedParticipants",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "setMinReqRegisteredParticipants",
    "inputs": [
      {
        "name": "newMinReqRegisteredParticipants",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "setOperationalThreshold",
    "inputs": [
      {
        "name": "newOperationalThreshold",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "whitelistEnclaveType",
    "inputs": [
      {
        "name": "enclaveType",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "enclaveTypeData",
        "type": "tuple",
        "internalType": "struct IDKG.EnclaveTypeData",
        "components": [
          {
            "name": "codeCommitment",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "validationHookAddr",
            "type": "address",
            "internalType": "address"
          }
        ]
      },
      {
        "name": "isWhitelisted",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "event",
    "name": "EnclaveTypeWhitelisted",
    "inputs": [
      {
        "name": "enclaveType",
        "type": "bytes32",
        "indexed": false,
        "internalType": "bytes32"
      },
      {
        "name": "codeCommitment",
        "type": "bytes32",
        "indexed": false,
        "internalType": "bytes32"
      },
      {
        "name": "validationHookAddr",
        "type": "address",
        "indexed": false,
        "internalType": "address"
      },
      {
        "name": "isWhitelisted",
        "type": "bool",
        "indexed": false,
        "internalType": "bool"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "FeeSet",
    "inputs": [
      {
        "name": "newFee",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "Finalized",
    "inputs": [
      {
        "name": "round",
        "type": "uint32",
        "indexed": false,
        "internalType": "uint32"
      },
      {
        "name": "validatorAddr",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "enclaveType",
        "type": "bytes32",
        "indexed": false,
        "internalType": "bytes32"
      },
      {
        "name": "codeCommitment",
        "type": "bytes32",
        "indexed": false,
        "internalType": "bytes32"
      },
      {
        "name": "participantsRoot",
        "type": "bytes32",
        "indexed": false,
        "internalType": "bytes32"
      },
      {
        "name": "globalPubKey",
        "type": "bytes",
        "indexed": false,
        "internalType": "bytes"
      },
      {
        "name": "publicCoeffs",
        "type": "bytes[]",
        "indexed": false,
        "internalType": "bytes[]"
      },
      {
        "name": "pubKeyShare",
        "type": "bytes",
        "indexed": false,
        "internalType": "bytes"
      },
      {
        "name": "signature",
        "type": "bytes",
        "indexed": false,
        "internalType": "bytes"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "MinReqFinalizedParticipantsSet",
    "inputs": [
      {
        "name": "newMinReqFinalizedParticipants",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "MinReqRegisteredParticipantsSet",
    "inputs": [
      {
        "name": "newMinReqRegisteredParticipants",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "OperationalThresholdSet",
    "inputs": [
      {
        "name": "newOperationalThreshold",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "Registered",
    "inputs": [
      {
        "name": "enclaveReport",
        "type": "bytes",
        "indexed": false,
        "internalType": "bytes"
      },
      {
        "name": "round",
        "type": "uint32",
        "indexed": false,
        "internalType": "uint32"
      },
      {
        "name": "validatorAddr",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "enclaveType",
        "type": "bytes32",
        "indexed": false,
        "internalType": "bytes32"
      },
      {
        "name": "enclaveCommKey",
        "type": "bytes",
        "indexed": false,
        "internalType": "bytes"
      },
      {
        "name": "dkgPubKey",
        "type": "bytes",
        "indexed": false,
        "internalType": "bytes"
      },
      {
        "name": "codeCommitment",
        "type": "bytes32",
        "indexed": false,
        "internalType": "bytes32"
      },
      {
        "name": "startBlockHeight",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "startBlockHash",
        "type": "bytes32",
        "indexed": false,
        "internalType": "bytes32"
      },
      {
        "name": "validationContext",
        "type": "bytes",
        "indexed": false,
        "internalType": "bytes"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "UpgradeCancelled",
    "inputs": [
      {
        "name": "upgradeVersion",
        "type": "string",
        "indexed": false,
        "internalType": "string"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "UpgradeScheduled",
    "inputs": [
      {
        "name": "activationHeight",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "upgradeVersion",
        "type": "string",
        "indexed": false,
        "internalType": "string"
      }
    ],
    "anonymous": false
  }
] as const;
