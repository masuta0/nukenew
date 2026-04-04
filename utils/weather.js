const axios = require('axios');

class WeatherUtil {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.baseUrl = 'https://api.openweathermap.org/data/2.5/weather';
  }

  async fetchWeather(city) {
    try {
      const response = await axios.get(this.baseUrl, {
        params: {
          q: city,
          appid: this.apiKey,
          units: 'metric', // or 'imperial' for Fahrenheit
        },
      });
      return response.data;
    } catch (error) {
      console.error('Error fetching weather data:', error);
      throw error;
    }
  }

  async fetchWeatherByCoordinates(latitude, longitude) {
    try {
      const response = await axios.get(this.baseUrl, {
        params: {
          lat: latitude,
          lon: longitude,
          appid: this.apiKey,
          units: 'metric',
        },
      });
      return response.data;
    } catch (error) {
      console.error('Error fetching weather data:', error);
      throw error;
    }
  }
}

module.exports = WeatherUtil;