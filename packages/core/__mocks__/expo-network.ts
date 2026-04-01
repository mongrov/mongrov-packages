const ExpoNetwork = {
  getNetworkStateAsync: jest.fn(async () => ({
    isConnected: true,
    type: 'wifi',
    isInternetReachable: true,
  })),
  NetworkStateType: {
    NONE: 'NONE',
    WIFI: 'WIFI',
    CELLULAR: 'CELLULAR',
  },
}

export = ExpoNetwork
