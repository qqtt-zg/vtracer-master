const path = require('path');

module.exports = {
  entry: "./bootstrap.js",
  resolve: {
    alias: {
      "vtracer-webapp$": path.resolve(__dirname, "generated", "vtracer_webapp_compat.js"),
    },
  },
  output: {
    path: path.resolve(__dirname, "dist"),
    filename: "bootstrap.js",
  },
  mode: "development",
  devServer: {
    //host: "0.0.0.0",
    contentBase: [
      path.resolve(__dirname),
      path.resolve(__dirname, "public"),
    ],
    port: 8080,
  }
};
