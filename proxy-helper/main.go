package main

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net"
	"net/netip"
	"os"

	"github.com/armon/go-socks5"
	"golang.org/x/crypto/curve25519"
	"golang.zx2c4.com/wireguard/conn"
	"golang.zx2c4.com/wireguard/device"
	"golang.zx2c4.com/wireguard/tun/netstack"
)

const (
	clientAddress = "10.8.255.254"
	clientPort    = 1080
)

type keypair struct {
	PrivateKey string `json:"privateKey"`
	PublicKey  string `json:"publicKey"`
}

type proxyConfig struct {
	Endpoint        string `json:"endpoint"`
	ServerPublicKey string `json:"serverPublicKey"`
	PrivateKey      string `json:"privateKey"`
}

func main() {
	if len(os.Args) < 2 {
		log.Fatal("usage: hc-proxy keygen|serve")
	}

	var err error
	if os.Args[1] == "keygen" {
		err = generateKeypair()
	} else if os.Args[1] == "serve" {
		err = serve()
	} else {
		err = fmt.Errorf("unknown command %q", os.Args[1])
	}
	if err != nil {
		log.Fatal(err)
	}
}

func generateKeypair() error {
	privateKey := make([]byte, curve25519.ScalarSize)
	if _, err := rand.Read(privateKey); err != nil {
		return err
	}
	publicKey, err := curve25519.X25519(privateKey, curve25519.Basepoint)
	if err != nil {
		return err
	}
	return json.NewEncoder(os.Stdout).Encode(keypair{
		PrivateKey: base64.StdEncoding.EncodeToString(privateKey),
		PublicKey:  base64.StdEncoding.EncodeToString(publicKey),
	})
}

func serve() error {
	var config proxyConfig
	if err := json.NewDecoder(os.Stdin).Decode(&config); err != nil {
		return fmt.Errorf("read config: %w", err)
	}

	privateHex, err := wireGuardKeyHex(config.PrivateKey)
	if err != nil {
		return fmt.Errorf("invalid private key: %w", err)
	}
	peerHex, err := wireGuardKeyHex(config.ServerPublicKey)
	if err != nil {
		return fmt.Errorf("invalid sandbox public key: %w", err)
	}
	if config.Endpoint == "" {
		return errors.New("endpoint is required")
	}

	tunDevice, network, err := netstack.CreateNetTUN(
		[]netip.Addr{netip.MustParseAddr(clientAddress)},
		nil,
		1420,
	)
	if err != nil {
		return err
	}
	dev := device.NewDevice(
		tunDevice,
		conn.NewDefaultBind(),
		device.NewLogger(device.LogLevelError, "wireguard: "),
	)
	defer dev.Close()
	wgConfig := fmt.Sprintf(
		"private_key=%s\nreplace_peers=true\npublic_key=%s\nendpoint=%s\n"+
			"persistent_keepalive_interval=25\nallowed_ip=10.8.0.0/16\n",
		privateHex,
		peerHex,
		config.Endpoint,
	)
	if err := dev.IpcSet(wgConfig); err != nil {
		return fmt.Errorf("configure WireGuard: %w", err)
	}
	if err := dev.Up(); err != nil {
		return fmt.Errorf("start WireGuard: %w", err)
	}

	listener, err := network.ListenTCP(&net.TCPAddr{
		IP:   net.ParseIP(clientAddress),
		Port: clientPort,
	})
	if err != nil {
		return fmt.Errorf("listen on virtual SOCKS address: %w", err)
	}
	defer listener.Close()
	server, err := socks5.New(&socks5.Config{})
	if err != nil {
		return err
	}
	return server.Serve(listener)
}

func wireGuardKeyHex(value string) (string, error) {
	decoded, err := base64.StdEncoding.DecodeString(value)
	if err != nil {
		return "", err
	}
	if len(decoded) != curve25519.ScalarSize {
		return "", fmt.Errorf("key must decode to %d bytes", curve25519.ScalarSize)
	}
	return hex.EncodeToString(decoded), nil
}
